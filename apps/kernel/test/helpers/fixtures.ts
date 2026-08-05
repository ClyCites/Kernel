import { SCHEMA_VERSION } from '@clycites/schema';
import { uuidv7 } from 'uuidv7';
import type { Pool } from 'pg';

import { ConversionService } from '../../src/registry/conversion.service.js';
import { AnchorRepository } from '../../src/anchoring/anchor.repository.js';
import { AnchorService } from '../../src/anchoring/anchor.service.js';
import { InferenceRepository } from '../../src/inference/inference.repository.js';
import { ReadService } from '../../src/records/read.service.js';
import { MediaRepository } from '../../src/media/media.repository.js';
import { AuditRepository } from '../../src/audit/audit.repository.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { AuditShipper } from '../../src/audit/audit.shipper.js';
import { DisclosureRepository } from '../../src/audit/disclosure.repository.js';
import { ConsentGrantService } from '../../src/consent/consent-grant.service.js';
import { ConsentRepository } from '../../src/consent/consent.repository.js';
import { DisclosureNotificationRepository } from '../../src/consent/disclosure-notification.repository.js';
import { DisclosureNotificationService } from '../../src/consent/disclosure-notification.service.js';
import { ObjectionRepository } from '../../src/consent/objection.repository.js';
import { RetentionNoticeRepository } from '../../src/consent/retention-notice.repository.js';
import { RetentionNoticeService } from '../../src/consent/retention-notice.service.js';
import { ObjectionService } from '../../src/consent/objection.service.js';
import { SubjectAccessService } from '../../src/consent/subject-access.service.js';
import { ConsentService } from '../../src/consent/consent.service.js';
import { DelegationService } from '../../src/records/delegation.service.js';
import { IngestService } from '../../src/records/ingest.service.js';
import type {
  IngestContext,
  IngestResult,
} from '../../src/records/ingest.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { RegistryRepository } from '../../src/registry/registry.repository.js';
import { DEFAULT_SUPERSESSION_MAX_DEPTH } from '../../src/records/lineage.js';
import type { KernelConfig } from '../../src/config.js';
import type { Reader } from '../../src/records/read.service.js';
import type { Dataset } from '../../src/records/record.js';

/**
 * Fixtures modelled on Appendix A of the specification — a farmer delivering
 * twelve bags of maize to a cooperative that weighs and confirms.
 */

/**
 * The write path, assembled by hand. Tests construct services directly rather
 * than through the Nest container because `tsx` does not emit decorator
 * metadata — see docs/decisions/0003-toolchain.md.
 *
 * The returned `ingest` supplies a default `IngestContext`. Production has no
 * such default and must not — see docs/decisions/0019-lawful-basis.md — but a
 * hundred tests restating the same lawful basis would obscure the handful that
 * are actually about it. Those pass one explicitly.
 *
 * `special_data_consent` is the default because `deliveryDocument` carries an
 * `agreed_price`, which makes it s.9(1) special data.
 */
/**
 * The audit log, wired to the real table with shipping switched off.
 *
 * Not a stub. Every read and every write goes through this, and a stub here
 * would mean the whole suite exercises a code path that does not write to the
 * column a data subject's s.24(1)(c) request is answered from. An empty ship
 * URL is the production default anyway — see audit.shipper.ts.
 */
export const auditServiceFor = (pool: Pool): AuditService =>
  new AuditService(
    new AuditRepository(pool),
    new AuditShipper({
      AUDIT_SHIP_URL: '',
      AUDIT_SHIP_TOKEN: '',
      AUDIT_SHIP_INTERVAL_SECONDS: 10,
      AUDIT_SHIP_BATCH: 200,
    }),
  );

/**
 * The decision point, wired to the real tables.
 *
 * The s.9 flag defaults to `true` here for the same reason it does in
 * production: a suite that ran with it false would prove the kernel works in a
 * configuration counsel has not approved. The tests that are about the flag
 * pass `false` explicitly and say so.
 */
export const consentServiceFor = (
  pool: Pool,
  s9ConsentRequired = true,
): ConsentService =>
  new ConsentService(new ConsentRepository(pool), {
    S9_CONSENT_REQUIRED_FOR_MEMBER_BODY: s9ConsentRequired,
  });

export const consentGrantServiceFor = (pool: Pool): ConsentGrantService =>
  new ConsentGrantService(new ConsentRepository(pool), auditServiceFor(pool));

/**
 * Anchoring with no publisher, which is the default deployment and the one
 * most tests want: batches are built and roots are stored, nothing goes to a
 * topic. `configured` is false, so freshness reports no staleness — a kernel
 * that was never asked to publish is not failing to.
 */
export const anchorServiceFor = (pool: Pool): AnchorService =>
  new AnchorService(
    new AnchorRepository(pool),
    new ReadService(
      new RecordRepository(pool),
      consentServiceFor(pool),
      objectionServiceFor(pool),
      auditServiceFor(pool),
      new InferenceRepository(pool),
    ),
    auditServiceFor(pool),
    null,
  );

export const retentionNoticeServiceFor = (pool: Pool): RetentionNoticeService =>
  new RetentionNoticeService(
    new RetentionNoticeRepository(pool),
    auditServiceFor(pool),
  );

export const objectionServiceFor = (pool: Pool): ObjectionService =>
  new ObjectionService(
    new ObjectionRepository(pool),
    new ConsentRepository(pool),
    auditServiceFor(pool),
  );

export const subjectAccessServiceFor = (pool: Pool): SubjectAccessService =>
  new SubjectAccessService(
    new RecordRepository(pool),
    new DisclosureRepository(pool),
    new ConsentRepository(pool),
    new ObjectionRepository(pool),
    auditServiceFor(pool),
  );

export const disclosureNotificationServiceFor = (
  pool: Pool,
): DisclosureNotificationService =>
  new DisclosureNotificationService(
    new RecordRepository(pool),
    new DisclosureRepository(pool),
    new DisclosureNotificationRepository(pool),
  );

export const ingestServiceFor = (
  pool: Pool,
  defaults: IngestContext = { lawfulBasis: 'special_data_consent' },
  config: Pick<KernelConfig, 'SUPERSESSION_MAX_DEPTH'> = {
    SUPERSESSION_MAX_DEPTH: DEFAULT_SUPERSESSION_MAX_DEPTH,
  },
): { ingest: TestIngest; service: IngestService; repository: RecordRepository } => {
  const repository = new RecordRepository(pool);
  const service = new IngestService(
    repository,
    new DelegationService(repository),
    new ConversionService(new RegistryRepository(pool)),
    auditServiceFor(pool),
    disclosureNotificationServiceFor(pool),
    config,
    new MediaRepository(pool),
  );
  const ingest: TestIngest = {
    ingest: (payload, context = {}) =>
      service.ingest(payload, { ...defaults, ...context }),
  };
  return { ingest, service, repository };
};

export interface TestIngest {
  ingest(payload: unknown, context?: IngestContext): Promise<IngestResult>;
}

/**
 * Reads as a given party. Consent denies everything else, so a test that reads
 * records must name someone entitled to see them — the subject or the asserter.
 */
export const readingAs = (
  requester: string | null,
  dataset: Dataset = 'live',
): Reader => ({ requester, dataset });

export const party = () => uuidv7();

export interface DeliveryOverrides {
  [key: string]: unknown;
}

export function deliveryDocument(
  overrides: DeliveryOverrides = {},
): Record<string, unknown> {
  const from = uuidv7();
  const to = uuidv7();

  return {
    id: uuidv7(),
    type: 'delivery',
    record_class: 'observation',
    schema_version: SCHEMA_VERSION,
    occurred_at: '2026-07-18T00:00:00+03:00',
    occurred_at_precision: 'day',
    asserted_by: to,
    from_party: from,
    to_party: to,
    commodity: 'crop.maize.grain',
    quantity: {
      raw_value: 12,
      raw_unit: 'bag',
      raw_unit_label: 'kaveera',
      normalized_kg: 1416,
      conversion_id: uuidv7(),
      measurement_method: 'coop_weighed',
    },
    location: uuidv7(),
    agreed_price: { amount_minor: 1150, currency: 'UGX' },
    ...overrides,
  };
}

export interface DelegationOverrides {
  [key: string]: unknown;
}

export function delegationDocument(
  delegator: string,
  delegate: string,
  overrides: DelegationOverrides = {},
): Record<string, unknown> {
  return {
    id: uuidv7(),
    type: 'delegation',
    record_class: 'observation',
    schema_version: SCHEMA_VERSION,
    occurred_at: '2026-01-05T09:00:00+03:00',
    occurred_at_precision: 'day',
    asserted_by: delegate,
    delegator,
    delegate,
    scope: ['delivery', 'harvest'],
    granted_at: '2026-01-05T09:00:00+03:00',
    granted_via: 'in_person_signature',
    ...overrides,
  };
}

const geoPoint = {
  lat: 0.3476,
  lon: 32.5825,
  accuracy_m: 8,
  captured_at: '2026-07-18T08:00:00+03:00',
  source: 'gps_device',
};

const adminRegion = { code: 'UG.MASAKA', vintage: '2020' };

const area = { value: 1.4, unit: 'hectare', method: 'gps_walked' };

const quantity = (normalizedKg = 1416) => ({
  raw_value: 12,
  raw_unit: 'bag',
  raw_unit_label: 'kaveera',
  normalized_kg: normalizedKg,
  conversion_id: uuidv7(),
  measurement_method: 'coop_weighed',
});

/**
 * One minimal, valid body per core entity. Used to demonstrate that the write
 * and read paths are entity-agnostic: nothing below is special-cased anywhere
 * in the kernel.
 *
 * `retraction` is absent because its `target` must name a record that exists.
 */
export const ENTITY_BODIES: Record<string, () => Record<string, unknown>> = {
  party: () => ({
    kind: 'person',
    display_name: 'Nakato Sarah',
    identifiers: [
      {
        scheme: 'ug.nira.nin',
        value: 'CM90000000AAAA',
        attested_by: uuidv7(),
        attested_at: '2026-01-04T09:00:00+03:00',
      },
    ],
    contacts: [{ channel: 'phone', value: '+256700000000' }],
    primary_region: adminRegion,
  }),
  account: () => ({
    account_id: uuidv7(),
    primary_party: uuidv7(),
    auth_subject: 'authentik|01J8XYZ',
    status: 'active',
  }),
  delegation: () => ({
    delegator: uuidv7(),
    delegate: uuidv7(),
    scope: ['delivery'],
    granted_at: '2026-01-05T09:00:00+03:00',
    granted_via: 'in_person_signature',
  }),
  membership: () => ({
    member: uuidv7(),
    organisation: uuidv7(),
    role: 'member',
    joined_at: '2024-03-01',
  }),
  facility: () => ({
    kind: 'collection_point',
    operated_by: uuidv7(),
    location: geoPoint,
    admin_region: adminRegion,
  }),
  plot: () => ({
    held_by: uuidv7(),
    tenure: 'customary',
    centroid: geoPoint,
    area,
    admin_region: adminRegion,
    local_name: 'Kyanja lower field',
  }),
  planting: () => ({
    plot: uuidv7(),
    crop: 'crop.maize.grain',
    variety: 'Longe 10H',
    season: '2026A',
    area_planted: area,
  }),
  harvest: () => ({
    plot: uuidv7(),
    crop: 'crop.maize.grain',
    quantity: quantity(),
  }),
  observation: () => ({
    subject_type: 'plot',
    subject_ref: uuidv7(),
    observation_type: 'soil.ph',
    value: { kind: 'scalar', value: 6.2, unit: 'pH' },
    method: 'field_instrument',
    instrument: 'Hanna HI-98103',
  }),
  lot: () => ({
    commodity: 'crop.maize.grain',
    quantity: quantity(),
    custodian: uuidv7(),
    location: uuidv7(),
  }),
  custody_transfer: () => ({
    lot: uuidv7(),
    from_party: uuidv7(),
    to_party: uuidv7(),
    location: uuidv7(),
    quantity: quantity(),
  }),
  delivery: () => ({
    from_party: uuidv7(),
    to_party: uuidv7(),
    commodity: 'crop.maize.grain',
    quantity: quantity(),
    location: uuidv7(),
    agreed_price: { amount_minor: 1150, currency: 'UGX' },
  }),
  // Every field here is a placeholder: a confirmation only ingests when the
  // delivery exists and the confirming party is the other side of it, so
  // callers always override `delivery` and `confirming_party`.
  delivery_confirmation: () => ({
    delivery: uuidv7(),
    confirming_party: uuidv7(),
    channel: 'ussd_pin',
  }),
  agreement: () => ({
    kind: 'forward',
    parties: [
      { party: uuidv7(), role: 'supplier' },
      { party: uuidv7(), role: 'buyer' },
    ],
    commodity: 'crop.maize.grain',
    quantity_committed: quantity(2000),
    price_terms: { basis: 'fixed', value: { amount_minor: 1150, currency: 'UGX' } },
    delivery_window: {
      from: '2026-07-01T00:00:00+03:00',
      to: '2026-09-30T00:00:00+03:00',
    },
    season: '2026A',
    agreed_at: '2026-04-02T10:00:00+03:00',
  }),
  obligation: () => ({
    kind: 'payment_for_goods',
    obligor: uuidv7(),
    obligee: uuidv7(),
    amount: { amount_minor: 1628400, currency: 'UGX' },
    due_at: '2026-08-01T00:00:00+03:00',
    arising_from: uuidv7(),
  }),
  settlement_reference: () => ({
    obligation: uuidv7(),
    amount: { amount_minor: 1628400, currency: 'UGX' },
    settled_at: '2026-07-25T14:02:00+03:00',
    rail: 'mtn_momo',
    external_ref: 'MP260725.1402.A12345',
    confirmed_by: uuidv7(),
  }),
};

/** A complete, valid record of the given type. */
export function entityDocument(
  type: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const body = ENTITY_BODIES[type];
  if (body === undefined) throw new Error(`no fixture for ${type}`);

  return {
    id: uuidv7(),
    type,
    record_class: 'observation',
    schema_version: SCHEMA_VERSION,
    occurred_at: '2026-07-18T00:00:00+03:00',
    occurred_at_precision: 'day',
    asserted_by: uuidv7(),
    ...body(),
    ...overrides,
  };
}

/** A retraction of a record that already exists. */
export function retractionDocument(
  target: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: uuidv7(),
    type: 'retraction',
    record_class: 'observation',
    schema_version: SCHEMA_VERSION,
    occurred_at: '2026-07-19T00:00:00+03:00',
    occurred_at_precision: 'day',
    asserted_by: uuidv7(),
    target,
    reason_code: 'test_entry',
    ...overrides,
  };
}
