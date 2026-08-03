import { Inject, Injectable } from '@nestjs/common';

import {
  ConsentService,
  type ConsentPurpose,
} from '../consent/consent.service.js';
import { schemaFor } from './entity-registry.js';
import { QueryRejected } from './errors.js';
import { resolveCustody, type Custody } from './custody.js';
import {
  DEFAULT_MASS_BALANCE_TOLERANCE,
  resolveMassBalance,
  type MassBalance,
} from './mass-balance.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import {
  EMPTY_TALLY,
  resolveFulfilment,
  type Fulfilment,
} from './fulfilment.js';
import { toDocument, type RecordDocument, type StoredRecord } from './record.js';
import { RecordRepository, type DerivedRecord } from './record.repository.js';
import {
  summariseSettlements,
  type SettlementSummary,
} from './settlement.js';
import {
  resolveSubject,
  subjectFields,
  subjectsOf,
  type SubjectResolution,
} from './subjects.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * Who is asking, and why. Every read carries one — there is no overload that
 * omits it, so a new read path cannot skip the consent guard by accident.
 */
export interface Reader {
  /** The verified subject claim. Null when none reached the kernel. */
  requester: string | null;
  /** Null means “my own records”. Any purpose is denied by the stub. */
  purpose?: ConsentPurpose | null | undefined;
}

export interface RecordView {
  /** Exactly the shape `@clycites/schema` defines for this entity. */
  record: RecordDocument;
  /** Kernel-derived. Never merged into the record itself. */
  quality_flags: string[];
  /** Direct superseders. More than one is a fork (spec §8 rule 4). */
  superseded_by: string[];
  retracted: boolean;
  /** Lots only. Where the custody chain says the lot actually is. */
  custody?: Custody;
  /** Lots only. Where the lot's mass went, across the custody sequence. */
  balance?: MassBalance;
  /** Agreements only. What the deliveries pointing at it add up to. */
  fulfilment?: Fulfilment;
  /** Observations only. Whether `subject_ref` names anything, and what. */
  subject?: SubjectResolution;
  /** Obligations only. What settlement records say about this one obligation. */
  settlement?: SettlementSummary;
}

export interface Page {
  records: RecordView[];
  next_cursor: string | null;
}

export interface ListOptions {
  type?: string | undefined;
  assertedBy?: string | undefined;
  subject?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/**
 * The read path. Brief §5 phase 3.
 *
 * A default read shows what is currently believed to be true: the tip of every
 * supersession chain, with retracted records absent. Everything else — the
 * superseded versions, the retracted ones — remains addressable by id, because
 * the log is append-only and a lender auditing a dispute needs to see what was
 * claimed before it was corrected.
 *
 * Every method here can return personal data and every method is therefore
 * behind the consent guard, which today denies everything but a party's own
 * records. See src/consent/consent.service.ts.
 */
@Injectable()
export class ReadService {
  constructor(
    @Inject(RecordRepository) private readonly repository: RecordRepository,
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'MASS_BALANCE_TOLERANCE'> = {
      MASS_BALANCE_TOLERANCE: DEFAULT_MASS_BALANCE_TOLERANCE,
    },
  ) {}

  /** By id, regardless of whether it has been superseded or retracted. */
  async get(id: string, reader: Reader): Promise<RecordView | null> {
    const found = await this.repository.findByIdWithDerived(id);
    if (found === null) return null;

    const view = recordView(found);
    this.guard([view], reader);
    await this.derive([view]);
    return view;
  }

  /**
   * The inference namespace, reachable only by asking for it. Brief §4
   * invariant 2: an inference must never turn up where an observation was
   * expected.
   */
  async getInference(id: string, reader: Reader): Promise<RecordView | null> {
    const found = await this.repository.findInferenceById(id);
    if (found === null) return null;

    const view = recordView({ ...found, superseded_by: [], retracted: false });
    this.guard([view], reader);
    return view;
  }

  async list(options: ListOptions, reader: Reader): Promise<Page> {
    if (options.type !== undefined && schemaFor(options.type) === null) {
      throw new QueryRejected(
        'unknown_record_type',
        `no entity named "${options.type}"`,
      );
    }

    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const rows = await this.repository.list({
      type: options.type,
      assertedBy: options.assertedBy,
      subject:
        options.subject === undefined
          ? undefined
          : { id: options.subject, fields: subjectFields(options.type) },
      limit: limit + 1,
      cursor: options.cursor === undefined ? undefined : decodeCursor(options.cursor),
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const views = page.map(recordView);
    this.guard(views, reader);
    await this.derive(views);

    return {
      records: views,
      next_cursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  /**
   * Every version of a record, oldest first, walkable from any point in the
   * chain rather than only from its origin.
   */
  async chain(id: string, reader: Reader): Promise<RecordView[]> {
    // Finding the origin is supersession resolution, not a disclosure: nothing
    // is returned to the caller until the guard below has run.
    this.consent.integrity('supersession_resolution');

    const origin = await this.repository.findChainOrigin(id);
    if (origin === null) return [];

    const chain = await this.repository.findSupersessionChain(origin);
    const retracted = new Set(
      await this.repository.retractedAmong(chain.map((record) => record.id)),
    );

    const views = chain.map((record) =>
      recordView({
        ...record,
        // Superseders are themselves in the chain, so this needs no extra query.
        superseded_by: chain
          .filter((other) => other.supersedes === record.id)
          .map((other) => other.id),
        retracted: retracted.has(record.id),
      }),
    );

    // Custody is deliberately not derived here. This view answers "what was
    // claimed, and when", and overwriting every historical version with the
    // current holder would erase the thing the caller came for.
    this.guard(views, reader);
    return views;
  }

  /**
   * Fields the schema marks derived and the kernel must therefore compute
   * rather than serve from the body. Runs after the guard, so nothing is
   * computed for records the caller was never entitled to see.
   */
  private async derive(views: RecordView[]): Promise<void> {
    await Promise.all([
      this.deriveLot(views),
      this.deriveFulfilment(views),
      this.deriveSubject(views),
      this.deriveSettlement(views),
    ]);
  }

  /**
   * What settlement records say about each obligation in the set.
   *
   * Scoped to one obligation at a time, on purpose. There is no path here that
   * totals what a party is owed across obligations — that number is a balance,
   * and the kernel is non-custodial by construction, not by policy.
   */
  private async deriveSettlement(views: RecordView[]): Promise<void> {
    const obligations = views.filter(
      (view) => view.record['type'] === 'obligation',
    );
    if (obligations.length === 0) return;

    const groups = await this.repository.settlementGroups(
      obligations.map((view) => view.record['id'] as string),
    );

    for (const view of obligations) {
      const id = view.record['id'] as string;
      view.settlement = summariseSettlements(
        view.record['amount'] as { amount_minor: number; currency: string },
        groups.filter((group) => group.obligation === id),
      );
    }
  }

  /**
   * Whether an observation's `subject_ref` names anything yet.
   *
   * Deliberately not settled at ingest. An observation can arrive before its
   * subject and later be about something perfectly real, so absence is a fact
   * about now rather than about the record.
   */
  private async deriveSubject(views: RecordView[]): Promise<void> {
    const observations = views.filter(
      (view) => view.record['type'] === 'observation',
    );
    if (observations.length === 0) return;

    const targets = await this.repository.recordTypesOf(
      observations.map((view) => view.record['subject_ref'] as string),
    );

    for (const view of observations) {
      const ref = view.record['subject_ref'] as string;
      view.subject = resolveSubject(
        String(view.record['subject_type']),
        ref,
        targets.get(ref),
      );
    }
  }

  /**
   * The two things a lot cannot know about itself: where it actually is, and
   * where its mass went. Both are read from the custody sequence, both are
   * computed for the whole page in one pair of queries.
   *
   * The stored `custodian` is replaced with the derived one. The balance is
   * attached alongside rather than merged, because it is kernel opinion and
   * the record body must read back as asserted.
   */
  private async deriveLot(views: RecordView[]): Promise<void> {
    const lots = views.filter((view) => view.record['type'] === 'lot');
    if (lots.length === 0) return;

    const ids = lots.map((view) => view.record['id'] as string);
    const [transfers, losses] = await Promise.all([
      this.repository.custodyTransfersFor(ids),
      this.repository.declaredLossesFor(ids),
    ]);

    for (const view of lots) {
      const id = view.record['id'] as string;
      const mine = transfers.filter((transfer) => transfer.lot === id);

      const custody = resolveCustody(
        view.record['custodian'] as string,
        mine,
      );
      view.custody = custody;
      view.record['custodian'] = custody.custodian;

      const quantity = view.record['quantity'] as
        | { normalized_kg?: number | null }
        | undefined;
      view.balance = resolveMassBalance(
        quantity?.normalized_kg ?? null,
        mine,
        losses.filter((loss) => loss.lot === id),
        this.config.MASS_BALANCE_TOLERANCE,
      );
    }
  }

  /**
   * What has been delivered against each agreement in the set. Summed on every
   * read; the Agreement carries no counter and must not grow one.
   */
  private async deriveFulfilment(views: RecordView[]): Promise<void> {
    const agreements = views.filter(
      (view) => view.record['type'] === 'agreement',
    );
    if (agreements.length === 0) return;

    const tallies = await this.repository.deliveryTallies(
      agreements.map((view) => view.record['id'] as string),
    );

    for (const view of agreements) {
      const id = view.record['id'] as string;
      const committed = view.record['quantity_committed'] as
        | { normalized_kg?: number | null }
        | undefined;

      view.fulfilment = resolveFulfilment(
        committed?.normalized_kg ?? null,
        tallies.get(id) ?? EMPTY_TALLY,
      );
    }
  }

  /**
   * The consent decision is built from the records that were actually fetched,
   * so a caller cannot nominate their own subjects. It throws rather than
   * filtering: half a page is not an answer.
   */
  private guard(views: RecordView[], reader: Reader): void {
    if (views.length === 0) return;

    this.consent.assertPermitted({
      subjects: views.flatMap((view) => subjectsOf(view.record)),
      asserters: views.map((view) => view.record['asserted_by'] as string),
      requester: reader.requester,
      purpose: reader.purpose ?? null,
      record_types: views.map((view) => view.record['type'] as string),
      at: new Date().toISOString(),
    });
  }
}

export function recordView(row: DerivedRecord): RecordView {
  return {
    // The schema's `superseded_by` holds one id; a fork has more than one, and
    // the array on the view is what callers must branch on.
    record: toDocument(row, { supersededBy: row.superseded_by[0] ?? null }),
    quality_flags: row.quality_flags,
    superseded_by: row.superseded_by,
    retracted: row.retracted,
  };
}

export function encodeCursor(record: StoredRecord): string {
  return Buffer.from(`${record.recorded_at}|${record.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): { recordedAt: string; id: string } {
  const [recordedAt, id, ...rest] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');

  if (
    recordedAt === undefined ||
    id === undefined ||
    rest.length > 0 ||
    Number.isNaN(Date.parse(recordedAt))
  ) {
    throw new QueryRejected('invalid_cursor', 'the cursor is not one we issued');
  }

  return { recordedAt, id };
}
