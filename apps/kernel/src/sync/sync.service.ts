import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { ConsentDenied, ConsentService } from '../consent/consent.service.js';
import { IngestService, type IngestContext } from '../records/ingest.service.js';
import { QueryRejected, RecordRejected } from '../records/errors.js';
import { RecordRepository } from '../records/record.repository.js';
import {
  decodeCursor,
  encodeCursor,
  recordView,
  type Reader,
  type RecordView,
} from '../records/read.service.js';
import { partiesOf, partyHopOf, subjectsOf } from '../records/subjects.js';
import { toDocument } from '../records/record.js';
import { carriesFinancialData } from '../records/lawful-basis.js';
import { DeviceRepository, type Device } from './device.repository.js';

const DEFAULT_BATCH = 100;
const MAX_BATCH = 500;
const DEFAULT_CHANGES = 100;
const MAX_CHANGES = 500;

/**
 * A device is not a core entity, so `@clycites/schema` has nothing to say about
 * it and this is the one place the kernel defines a shape of its own. It is
 * operational state, not a fact about the world — see the module comment on
 * `DeviceRepository`.
 */
export const DeviceRegistration = z.object({
  device_id: z.uuid({ version: 'v7' }),
  registered_by: z.uuid({ version: 'v7' }),
  label: z.string().min(1).max(120),
});
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;

export interface DrainOutcome {
  /** The client-generated id, echoed so a device can retire its outbox entry. */
  id: string | null;
  outcome: 'accepted' | 'replayed' | 'rejected';
  code?: string;
  detail?: string;
  issues?: { path: string; message: string }[];
}

export interface Changes {
  records: RecordView[];
  next_cursor: string | null;
  /** False when the device has caught up. */
  has_more: boolean;
}

/**
 * Offline sync. Brief §4 invariant 5: offline is the default, not a feature.
 *
 * Two endpoints and no state machine. A device drains its outbox by posting the
 * records it captured, and pulls what it missed with a cursor it holds itself.
 * The kernel stores no per-device position: a cursor the client keeps cannot
 * drift from what the client actually has, and a cursor the server keeps
 * requires an UPDATE per pull, which invariant 1 does not permit anywhere in
 * this codebase. See docs/decisions/0008-sync.md.
 */
@Injectable()
export class SyncService {
  constructor(
    @Inject(IngestService) private readonly ingest: IngestService,
    @Inject(RecordRepository) private readonly repository: RecordRepository,
    @Inject(DeviceRepository) private readonly devices: DeviceRepository,
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async register(
    payload: unknown,
  ): Promise<{ device: Device; created: boolean }> {
    const parsed = DeviceRegistration.safeParse(payload);
    if (!parsed.success) {
      throw new RecordRejected(
        'malformed_record',
        'the device registration is not well formed',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const existing = await this.devices.find(parsed.data.device_id);
    if (
      existing !== null &&
      existing.registered_by !== parsed.data.registered_by
    ) {
      throw new RecordRejected(
        'id_conflict',
        'that device id is already registered to another party',
        [{ path: 'device_id', message: 'registered to a different party' }],
      );
    }

    return this.devices.registerIfAbsent(parsed.data);
  }

  /**
   * Drain an outbox. Every record is processed independently and the response
   * says what happened to each, because a batch that fails whole strands a
   * device: it cannot tell which of the fifty records it captured this week
   * were the problem, and retrying the batch never succeeds.
   *
   * Replaying a batch is safe. Ingest is idempotent per id, so a device that
   * loses the response and posts again gets `replayed` rather than a conflict.
   */
  async drain(
    payload: unknown,
    context: IngestContext = {},
  ): Promise<DrainOutcome[]> {
    if (!Array.isArray(payload)) {
      throw new RecordRejected(
        'malformed_record',
        'expected an array of records',
      );
    }
    if (payload.length > MAX_BATCH) {
      throw new RecordRejected(
        'malformed_record',
        `a batch may carry at most ${MAX_BATCH} records`,
      );
    }

    const outcomes: DrainOutcome[] = [];
    for (const entry of payload) {
      outcomes.push(await this.one(entry, context));
    }
    return outcomes;
  }

  /**
   * Everything the requesting party appended after `cursor`, oldest first.
   *
   * This is the widest disclosure surface in the kernel, so it is scoped to the
   * requester at the query level and then put through the same consent guard as
   * every other read. An unauthenticated pull returns nothing rather than
   * everything.
   */
  async changes(
    options: {
      cursor?: string | undefined;
      limit?: number | undefined;
    },
    reader: Reader,
  ): Promise<Changes> {
    if (reader.requester === null) {
      const decision = await this.consent.decide({
        records: [],
        requester: null,
        purpose: reader.purpose ?? null,
        dataset: reader.dataset ?? 'live',
        at: new Date().toISOString(),
      });
      // Recorded before the throw. An unauthenticated pull against the widest
      // disclosure surface in the kernel is exactly the event that matters, and
      // it is the one a log written on the success path would never see.
      await this.audit.record({
        action: 'consent.denied',
        outcome: 'denied',
        dataset: reader.dataset ?? 'live',
        reason: decision.reason,
        actor: null,
        purpose: reader.purpose ?? null,
        detail: { by: 'sync_changes', paged: options.cursor !== undefined },
        correlationId: reader.correlationId ?? null,
      });
      throw new ConsentDenied(decision);
    }

    const limit = Math.min(options.limit ?? DEFAULT_CHANGES, MAX_CHANGES);
    const after =
      options.cursor === undefined ? undefined : decodeCursor(options.cursor);

    const rows = await this.repository.since(
      after,
      limit + 1,
      reader.requester,
      reader.dataset ?? 'live',
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const views = page.map(recordView);

    if (views.length > 0) {
      // From the stored rows, not the views: `lawful_basis` is kernel metadata
      // and never appears in the document a caller receives.
      const records = page.map((record) => {
        const document = toDocument(record);
        return {
          id: record.id,
          type: record.type,
          subjects: subjectsOf(document),
          parties: partiesOf(document),
          via: partyHopOf(document),
          asserted_by: record.asserted_by,
          occurred_at: record.occurred_at,
          financial: carriesFinancialData(record.type, record.body),
          lawful_basis: record.lawful_basis,
        };
      });

      const decision = await this.consent.decide({
        records,
        requester: reader.requester,
        purpose: reader.purpose ?? null,
        dataset: reader.dataset ?? 'live',
        at: new Date().toISOString(),
      });

      await this.audit.record({
        action: decision.allowed ? 'record.read' : 'consent.denied',
        outcome: decision.allowed ? 'allowed' : 'denied',
        dataset: reader.dataset ?? 'live',
        reason: decision.reason,
        actor: reader.requester,
        purpose: reader.purpose ?? null,
        subjects: records.flatMap((record) => record.subjects),
        records: records.map((record) => record.id),
        recordTypes: records.map((record) => record.type),
        detail: {
          by: 'sync_changes',
          returned: views.length,
          access: decision.access ?? null,
          grants: decision.grants.length,
        },
        correlationId: reader.correlationId ?? null,
      });

      if (!decision.allowed) throw new ConsentDenied(decision);
    }

    return {
      records: views,
      next_cursor: last === undefined ? (options.cursor ?? null) : encodeCursor(last),
      has_more: rows.length > limit,
    };
  }

  private async one(
    entry: unknown,
    context: IngestContext,
  ): Promise<DrainOutcome> {
    const id = idOf(entry);
    try {
      const result = await this.ingest.ingest(entry, context);
      return {
        id: result.record.id,
        outcome: result.replayed ? 'replayed' : 'accepted',
      };
    } catch (error) {
      if (error instanceof RecordRejected) {
        return {
          id,
          outcome: 'rejected',
          code: error.code,
          detail: error.message,
          issues: error.issues,
        };
      }
      if (error instanceof QueryRejected) {
        return { id, outcome: 'rejected', code: error.code, detail: error.message };
      }
      throw error;
    }
  }
}

function idOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const id = (entry as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : null;
}

export { DEFAULT_BATCH, MAX_BATCH, MAX_CHANGES };
