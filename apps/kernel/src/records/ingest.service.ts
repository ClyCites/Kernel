import { Inject, Injectable } from '@nestjs/common';

import { schemaFor, registeredTypes } from './entity-registry.js';
import { RecordRejected } from './errors.js';
import { qualityFlags } from './quality.js';
import { chainDepth, DEFAULT_SUPERSESSION_MAX_DEPTH } from './lineage.js';
import { DelegationService } from './delegation.service.js';
import { ConversionService } from '../registry/conversion.service.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import { RecordRepository } from './record.repository.js';
import { subjectTypeMismatched } from './subjects.js';
import {
  splitEnvelope,
  type Dataset,
  type RecordDocument,
  type StoredRecord,
} from './record.js';
import {
  checkBasis,
  isLawfulBasis,
  LAWFUL_BASES,
  type LawfulBasis,
} from './lawful-basis.js';

/**
 * What the kernel knows about a write that the payload does not say.
 *
 * `dataset` is here rather than in the envelope on purpose. @clycites/schema
 * describes what a record asserts about the world; which corpus a row belongs
 * to is not a claim anybody is making, and a client that could assert it could
 * mark its own records `seed` to slip past anchoring.
 *
 * `lawfulBasis` has no default. DPPA s.7(3) decides whether a farmer can stop
 * us processing a record by looking at the ground relied on when it was
 * collected, and this log is append-only, so a record that arrives without one
 * can never acquire one. A caller that cannot state a basis has not established
 * that it may hold the data at all.
 */
export interface IngestContext {
  dataset?: Dataset | undefined;
  lawfulBasis?: LawfulBasis | undefined;
}

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
    @Inject(RecordRepository) private readonly repository: RecordRepository,
    @Inject(DelegationService) private readonly delegations: DelegationService,
    @Inject(ConversionService) private readonly conversions: ConversionService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SUPERSESSION_MAX_DEPTH'> = {
      SUPERSESSION_MAX_DEPTH: DEFAULT_SUPERSESSION_MAX_DEPTH,
    },
  ) {}

  async ingest(
    payload: unknown,
    context: IngestContext = {},
  ): Promise<IngestResult> {
    const dataset = context.dataset ?? 'live';
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
    // `superseded_by` and `stale` are derived and likewise not accepted from
    // the wire — a client able to assert `stale: false` could assert its way
    // out of the re-run a superseded input is supposed to force.
    const candidate: RecordDocument = {
      ...submitted,
      recorded_at: new Date().toISOString(),
    };
    delete candidate['superseded_by'];
    delete candidate['stale'];

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

    const lawfulBasis = this.statedBasis(context, type, body);

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

    const supersessionFlags = await this.checkSupersession(envelope, type, dataset);
    if (type === 'retraction') await this.checkRetraction(envelope, body, dataset);
    // A client-supplied `normalized_kg` the kernel cannot reproduce is exactly
    // what currently looks trustworthy and isn't. Per P6 this flags, never
    // rejects — the record is still someone's account of what happened.
    const conversionFlags = await this.conversions.flags(
      document,
      String(envelope['occurred_at']),
    );

    const derived = [
      ...conversionFlags,
      ...supersessionFlags,
      ...(await this.subjectFlags(type, body, dataset)),
    ];

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
        precomputed: derived,
      }),
      dataset,
      lawful_basis: lawfulBasis,
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
   * it replaces, written by the party who made the original claim or by someone
   * holding an explicit correction right over them.
   *
   * Returns the flags the correction carries, so weaker authority stays visible
   * on the record rather than only in the delegation it named.
   */
  private async checkSupersession(
    envelope: RecordDocument,
    type: string,
    dataset: Dataset,
  ): Promise<string[]> {
    const supersedes = asNullableString(envelope['supersedes']);
    if (supersedes === null) return [];

    const target = await this.repository.findById(supersedes);
    // A record in another corpus is not visible from this one, so it reads as
    // absent rather than as a cross-corpus error. Saying otherwise would let a
    // caller probe the live log for ids by watching which message came back.
    if (!target || target.dataset !== dataset) {
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

    const flags = await this.checkChainShape(envelope, supersedes);
    return [...flags, ...(await this.checkCorrectionRight(envelope, target, type))];
  }

  /**
   * Spec §8 rule 3. Refuse a link that would close a cycle, and bound how long
   * a chain may grow.
   *
   * A cycle cannot be built today: `supersedes` must name a record already in
   * the log, and a fresh record's id is by definition not, so every edge points
   * from a new node to an old one. That argument holds only as long as both
   * halves do, and it lives in two different methods — this check makes the
   * property local instead of emergent, and costs one query on the rare write
   * that supersedes anything at all.
   */
  private async checkChainShape(
    envelope: RecordDocument,
    supersedes: string,
  ): Promise<string[]> {
    const limit = this.config.SUPERSESSION_MAX_DEPTH;
    const ancestry = await this.repository.ancestorsOf(supersedes, limit);
    const id = String(envelope['id']);

    if (ancestry.ids.includes(id)) {
      throw new RecordRejected(
        'supersession_invalid',
        `record ${id} already appears in the chain it would supersede — this would close a cycle`,
        [{ path: 'supersedes', message: 'a correction may not close a cycle' }],
      );
    }

    const { depth, exceeded, deep } = chainDepth(ancestry.depth, limit);
    if (exceeded) {
      // Structural, not a judgement about the contents. Past the bound the
      // chain stops being resolvable on the read path, so accepting the record
      // would make every later read of it wrong rather than merely slow.
      throw new RecordRejected(
        'supersession_invalid',
        `the supersession chain is ${depth} deep and the limit is ${limit}`,
        [{ path: 'supersedes', message: 'correction chain too long' }],
      );
    }

    return deep ? ['supersession_chain_deep'] : [];
  }

  /**
   * Spec §8 rule 1. Only the original `asserted_by`, or a party holding an
   * explicit correction right over them, may supersede.
   *
   * The correction right is a Delegation, resolved exactly as `on_behalf_of` is
   * — in scope for the record type, active at `occurred_at`, not revoked or
   * retracted. It must be named on the record. Searching the log for some
   * delegation that happens to authorise the writer would mean a correction's
   * authority depended on what else had been written since, which is not a
   * thing anyone could audit.
   */
  private async checkCorrectionRight(
    envelope: RecordDocument,
    target: StoredRecord,
    type: string,
  ): Promise<string[]> {
    // `on_behalf_of` is the party whose claim this is, and it has already been
    // checked against a delegation by this point.
    const claimant =
      asNullableString(envelope['on_behalf_of']) ??
      String(envelope['asserted_by']);
    const originalClaimant = target.on_behalf_of ?? target.asserted_by;

    if (claimant === originalClaimant) return [];

    const named = asNullableString(envelope['delegation']);
    if (named === null || envelope['on_behalf_of'] != null) {
      throw new RecordRejected(
        'supersession_invalid',
        `only ${originalClaimant}, or a party they have delegated correction of ${type} to, may correct this record`,
        [
          {
            path: 'supersedes',
            message: 'the correction comes from a different party',
          },
        ],
      );
    }

    const grant = await this.delegations.authorise({
      delegation: named,
      delegator: originalClaimant,
      delegate: claimant,
      recordType: type,
      occurredAt: String(envelope['occurred_at']),
    });

    // Spec §5.3. A correction somebody made to their own claim and one made for
    // them under a coop bylaw are not equal evidence, and the chain view is
    // where a lender sees the difference.
    return grant.basis === 'organisational_bylaw'
      ? ['corrected_under_delegation', 'corrected_under_organisational_bylaw']
      : ['corrected_under_delegation'];
  }

  /**
   * The DPPA ground this record is collected under, from the calling
   * application's declared purpose.
   *
   * Rejecting is correct here, unlike almost everywhere else in this service.
   * P6 says flag rather than reject because a malformed claim is still someone's
   * account of what happened — but an unstated basis is not a defect in the
   * farmer's account, it is a defect in our authority to hold it, and storing it
   * flagged would be doing the unlawful thing with a note attached.
   */
  private statedBasis(
    context: IngestContext,
    type: string,
    body: RecordDocument,
  ): LawfulBasis {
    const stated = context.lawfulBasis;
    if (stated === undefined || !isLawfulBasis(stated)) {
      throw new RecordRejected(
        'lawful_basis_required',
        `a record must state the DPPA s.7 or s.9 ground it is collected under — one of ${LAWFUL_BASES.join(', ')}`,
        [{ path: 'lawful_basis', message: 'required' }],
      );
    }

    const rejection = checkBasis(stated, type, body);
    if (rejection !== null) {
      throw new RecordRejected('lawful_basis_insufficient', rejection.message, [
        { path: 'lawful_basis', message: rejection.detail },
      ]);
    }

    return stated;
  }

  /**
   * An observation whose subject is present but is the wrong kind of thing.
   *
   * Only the mismatch is stored. A subject that has not arrived is not flagged:
   * observations routinely sync ahead of their subjects, so a flag written once
   * would record the order the phones reconnected in rather than anything about
   * the record. Existence is answered at read time instead.
   */
  private async subjectFlags(
    type: string,
    body: RecordDocument,
    dataset: Dataset,
  ): Promise<string[]> {
    if (type !== 'observation') return [];
    const ref = body['subject_ref'];
    if (typeof ref !== 'string') return [];

    const found = await this.repository.recordTypesOf([ref], dataset);
    return subjectTypeMismatched(String(body['subject_type']), found.get(ref))
      ? ['subject_type_mismatch']
      : [];
  }

  /**
   * Spec §8.1. A retraction hides a record from default reads without removing
   * it, so it has the same authority requirement as a correction.
   */
  private async checkRetraction(
    envelope: RecordDocument,
    body: RecordDocument,
    dataset: Dataset,
  ): Promise<void> {
    const targetId = String(body['target']);
    const target = await this.repository.findById(targetId);

    if (!target || target.dataset !== dataset) {
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
