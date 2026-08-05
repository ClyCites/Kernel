import type { z } from 'zod';
import {
  Account,
  Agreement,
  CustodyTransfer,
  Delegation,
  Delivery,
  DeliveryConfirmation,
  Facility,
  Harvest,
  Lot,
  Membership,
  Obligation,
  Observation,
  Party,
  Planting,
  Plot,
  Retraction,
  SettlementReference,
} from '@clycites/schema';

/**
 * The entity schemas the kernel accepts, keyed by envelope `type`.
 *
 * Every entry points at `@clycites/schema`. Nothing here restates a field, and
 * nothing validates a record a second time (brief §7).
 *
 * All sixteen core entities are here, and none of them needed special handling.
 * The envelope is identical across entities, so ingest, provenance,
 * supersession and idempotency are entity-agnostic. The only per-entity code in
 * the kernel is two lookup tables — which fields name a record's subject
 * (`subjects.ts`) and which plausibility checks apply (`quality.ts`) — not
 * branches in the pipeline.
 *
 * `delivery_confirmation` is the one exception to that last claim, and it is a
 * narrow one: who may assert it is decided by another record's contents, so
 * ingest checks it. See `checkConfirmationRight`.
 */
export const ENTITY_SCHEMAS = {
  party: Party,
  account: Account,
  delegation: Delegation,
  membership: Membership,
  facility: Facility,
  plot: Plot,
  planting: Planting,
  harvest: Harvest,
  observation: Observation,
  lot: Lot,
  custody_transfer: CustodyTransfer,
  delivery: Delivery,
  delivery_confirmation: DeliveryConfirmation,
  agreement: Agreement,
  obligation: Obligation,
  settlement_reference: SettlementReference,
  retraction: Retraction,
} as const satisfies Record<string, z.ZodType>;

export type RegisteredEntityType = keyof typeof ENTITY_SCHEMAS;

export function schemaFor(type: string): z.ZodType | null {
  return Object.prototype.hasOwnProperty.call(ENTITY_SCHEMAS, type)
    ? (ENTITY_SCHEMAS[type as RegisteredEntityType] as z.ZodType)
    : null;
}

export function registeredTypes(): string[] {
  return Object.keys(ENTITY_SCHEMAS).sort();
}
