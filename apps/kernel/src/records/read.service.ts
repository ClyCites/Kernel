import { Inject, Injectable } from '@nestjs/common';

import { schemaFor } from './entity-registry.js';
import { QueryRejected } from './errors.js';
import { toDocument, type RecordDocument, type StoredRecord } from './record.js';
import { RecordRepository, type DerivedRecord } from './record.repository.js';
import { subjectFields } from './subjects.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface RecordView {
  /** Exactly the shape `@clycites/schema` defines for this entity. */
  record: RecordDocument;
  /** Kernel-derived. Never merged into the record itself. */
  quality_flags: string[];
  /** Direct superseders. More than one is a fork (spec §8 rule 4). */
  superseded_by: string[];
  retracted: boolean;
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
 */
@Injectable()
export class ReadService {
  constructor(
    @Inject(RecordRepository) private readonly repository: RecordRepository,
  ) {}

  /** By id, regardless of whether it has been superseded or retracted. */
  async get(id: string): Promise<RecordView | null> {
    const found = await this.repository.findByIdWithDerived(id);
    return found === null ? null : view(found);
  }

  /**
   * The inference namespace, reachable only by asking for it. Brief §4
   * invariant 2: an inference must never turn up where an observation was
   * expected.
   */
  async getInference(id: string): Promise<RecordView | null> {
    const found = await this.repository.findInferenceById(id);
    if (found === null) return null;
    return view({ ...found, superseded_by: [], retracted: false });
  }

  async list(options: ListOptions = {}): Promise<Page> {
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
    return {
      records: page.map(view),
      next_cursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  /**
   * Every version of a record, oldest first, walkable from any point in the
   * chain rather than only from its origin.
   */
  async chain(id: string): Promise<RecordView[]> {
    const origin = await this.repository.findChainOrigin(id);
    if (origin === null) return [];

    const chain = await this.repository.findSupersessionChain(origin);
    const retracted = new Set(
      await this.repository.retractedAmong(chain.map((record) => record.id)),
    );

    return chain.map((record) =>
      view({
        ...record,
        // Superseders are themselves in the chain, so this needs no extra query.
        superseded_by: chain
          .filter((other) => other.supersedes === record.id)
          .map((other) => other.id),
        retracted: retracted.has(record.id),
      }),
    );
  }
}

function view(row: DerivedRecord): RecordView {
  return {
    // The schema's `superseded_by` holds one id; a fork has more than one, and
    // the array on the view is what callers must branch on.
    record: toDocument(row, { supersededBy: row.superseded_by[0] ?? null }),
    quality_flags: row.quality_flags,
    superseded_by: row.superseded_by,
    retracted: row.retracted,
  };
}

function encodeCursor(record: StoredRecord): string {
  return Buffer.from(`${record.recorded_at}|${record.id}`, 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { recordedAt: string; id: string } {
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
