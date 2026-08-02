import { SCHEMA_VERSION } from '@clycites/schema';
import { uuidv7 } from 'uuidv7';

/**
 * Fixtures modelled on Appendix A of the specification — a farmer delivering
 * twelve bags of maize to a cooperative that weighs and confirms.
 */

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
