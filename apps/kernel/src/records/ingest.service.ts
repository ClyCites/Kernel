import { Injectable } from '@nestjs/common';

import { schemaFor, registeredTypes } from './entity-registry.js';
import { RecordRejected } from './errors.js';
import { qualityFlags } from './quality.js';
import { DelegationService } from './delegation.service.js';
import { RecordRepository } from './record.repository.js';
import {
  splitEnvelope,
  type RecordDocument,
  type StoredRecord,
} from './record.js';

export interface IngestResult {
  record: StoredRecord;
  /** The id was already in the log; nothing was written. */
  replayed: boolean;
}

/**
 * The write path. Brief Phase 2:
 *
 *   envelope validation → provenance check → delegation resolution →
 *   idempotency → quality flagging → append
 *
 * Validation is delegated entirely to `@clycites/schema`. There is no second
 * set of rules here, and there must never be one: the moment the kernel decides
 * for itself what a Delivery looks like, the schema stops being the source of
 * truth.
 */
@Injectable()
export class IngestService {
  constructor(
    private readonly repository: RecordRepository,
    private readonly delegations: DelegationService,
  ) {}

  async ingest(payload: unknown): Promise<IngestResult> {
    const submitted = this.asObject(payload);
    const type = this.entityType(submitted);
    const schema = schemaFor(type);

    if (!schema) {
      throw new RecordRejected(
        'unknown_record_type',
        `no entity named "${type}" — known types are ${registeredTypes().join(', ')}`,
        [{ path: 'type', message: 'unknown record type' }],
      );
    }

    // `recorded_at` is set by the kernel on receipt, never by the client
    // (spec §4). A client-supplied value is discarded rather than trusted.
    // `superseded_by` is derived and likewise not accepted from the wire.
    const candidate: RecordDocument = {
      ...submitted,
      recorded_at: new Date().toISOString(),
    };
    delete candidate['superseded_by'];

    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      throw new RecordRejected(
        'malformed_record',
        `the record does not satisfy the ${type} schema`,
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      );
    }

    const document = parsed.data as RecordDocument;
    const { envelope, body } = splitEnvelope(document);

    const grant =
      envelope['on_behalf_of'] == null
        ? null
        : await this.delegations.authorise({
            delegation: String(envelope['delegation']),
            delegator: String(envelope['on_behalf_of']),
            delegate: String(envelope['asserted_by']),
            recordType: type,
            occurredAt: String(envelope['occurred_at']),
          });

    await this.checkSupersession(envelope, type);
    if (type === 'retraction') await this.checkRetraction(envelope, body);

    const record: StoredRecord = {
      id: String(envelope['id']),
      type,
      record_class: 'observation',
      schema_version: String(envelope['schema_version']),
      occurred_at: String(envelope['occurred_at']),
      occurred_at_precision: String(envelope['occurred_at_precision']),
      recorded_at: String(envelope['recorded_at']),
      asserted_by: String(envelope['asserted_by']),
      authenticated_as: asNullableString(envelope['authenticated_as']),
      on_behalf_of: asNullableString(envelope['on_behalf_of']),
      delegation: asNullableString(envelope['delegation']),
      device_id: asNullableString(envelope['device_id']),
      supersedes: asNullableString(envelope['supersedes']),
      body,
      ext: (envelope['ext'] as Record<string, unknown> | undefined) ?? {},
      quality_flags: qualityFlags({
        type,
        document,
        delegationBasis: grant?.basis ?? null,
      }),
    };

    const result = await this.repository.appendIfAbsent(record);

    if (result.replayed && !sameRecord(result.record, record)) {
      // Idempotency is on the id. Two different records sharing one id is a
      // client generating ids badly, and silently returning the first would
      // hide it. This is structural, not a business rule.
      throw new RecordRejected(
        'id_conflict',
        `record ${record.id} already exists with different contents`,
        [{ path: 'id', message: 'id already used by a different record' }],
      );
    }

    return result;
  }

  /**
   * Spec §8. A correction is a new record of the same type pointing at the one
   * it replaces, written by the party who made the original claim.
   */
  private async checkSupersession(
    envelope: RecordDocument,
    type: string,
  ): Promise<void> {
    const supersedes = asNullableString(envelope['supersedes']);
    if (supersedes === null) return;

    const target = await this.repository.findById(supersedes);
    if (!target) {
      throw new RecordRejected(
        'supersession_invalid',
        `record ${supersedes} is not in the log`,
        [{ path: 'supersedes', message: 'no such record' }],
      );
    }

    if (target.type !== type) {
      throw new RecordRejected(
        'supersession_invalid',
        `a ${type} cannot supersede a ${target.type}`,
        [{ path: 'supersedes', message: 'a correction must be of the same type' }],
      );
    }

    // Spec §8 rule 1. `on_behalf_of` is the party whose claim this is, and it
    // has already been checked against a delegation by this point.
    const claimant =
      asNullableString(envelope['on_behalf_of']) ??
      String(envelope['asserted_by']);
    const originalClaimant = target.on_behalf_of ?? target.asserted_by;

    if (claimant !== originalClaimant) {
      throw new RecordRejected(
        'supersession_invalid',
        `only ${originalClaimant} may correct their own record`,
        [
          {
            path: 'supersedes',
            message: 'the correction comes from a different party',
          },
        ],
      );
    }
  }

  /**
   * Spec §8.1. A retraction hides a record from default reads without removing
   * it, so it has the same authority requirement as a correction.
   */
  private async checkRetraction(
    envelope: RecordDocument,
    body: RecordDocument,
  ): Promise<void> {
    const targetId = String(body['target']);
    const target = await this.repository.findById(targetId);

    if (!target) {
      throw new RecordRejected(
        'supersession_invalid',
        `record ${targetId} is not in the log`,
        [{ path: 'target', message: 'no such record' }],
      );
    }

    const claimant =
      asNullableString(envelope['on_behalf_of']) ??
      String(envelope['asserted_by']);
    const originalClaimant = target.on_behalf_of ?? target.asserted_by;

    if (claimant !== originalClaimant) {
      throw new RecordRejected(
        'supersession_invalid',
        `only ${originalClaimant} may retract their own record`,
        [{ path: 'target', message: 'the retraction comes from a different party' }],
      );
    }
  }

  private asObject(payload: unknown): RecordDocument {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new RecordRejected('malformed_record', 'a record must be an object');
    }
    return payload as RecordDocument;
  }

  private entityType(document: RecordDocument): string {
    const type = document['type'];
    if (typeof type !== 'string' || type.length === 0) {
      throw new RecordRejected(
        'malformed_record',
        'the envelope must carry a record type',
        [{ path: 'type', message: 'required' }],
      );
    }
    return type;
  }
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Whether a replayed submission is the same record as the one stored.
 *
 * `recorded_at` is excluded — the kernel assigns it, so it differs on every
 * submission by construction. Timestamps are compared as instants because the
 * log stores UTC while a device may have sent `+03:00`.
 */
function sameRecord(stored: StoredRecord, incoming: StoredRecord): boolean {
  const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

  return (
    stored.type === incoming.type &&
    stored.record_class === incoming.record_class &&
    stored.schema_version === incoming.schema_version &&
    sameInstant(stored.occurred_at, incoming.occurred_at) &&
    stored.occurred_at_precision === incoming.occurred_at_precision &&
    stored.asserted_by === incoming.asserted_by &&
    stored.authenticated_as === incoming.authenticated_as &&
    stored.on_behalf_of === incoming.on_behalf_of &&
    stored.delegation === incoming.delegation &&
    stored.device_id === incoming.device_id &&
    stored.supersedes === incoming.supersedes &&
    stable(stored.body) === stable(incoming.body) &&
    stable(stored.ext) === stable(incoming.ext)
  );
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
