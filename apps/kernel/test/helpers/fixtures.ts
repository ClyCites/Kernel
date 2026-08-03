import { SCHEMA_VERSION } from '@clycites/schema';
import { uuidv7 } from 'uuidv7';
import type { Pool } from 'pg';

import { ConversionService } from '../../src/registry/conversion.service.js';
import { DelegationService } from '../../src/records/delegation.service.js';
import { IngestService } from '../../src/records/ingest.service.js';
import type {
  IngestContext,
  IngestResult,
} from '../../src/records/ingest.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { RegistryRepository } from '../../src/registry/registry.repository.js';
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
export const ingestServiceFor = (
  pool: Pool,
  defaults: IngestContext = { lawfulBasis: 'special_data_consent' },
): { ingest: TestIngest; service: IngestService; repository: RecordRepository } => {
  const repository = new RecordRepository(pool);
  const service = new IngestService(
    repository,
    new DelegationService(repository),
    new ConversionService(new RegistryRepository(pool)),
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
