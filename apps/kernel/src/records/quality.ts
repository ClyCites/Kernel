import { isUnderwritable, type MeasurementMethod, type RawUnit } from '@clycites/schema';

/**
 * Quality flagging. Brief §4 invariant 4, spec §1 P6.
 *
 * Nothing here can refuse a record. A field officer standing in a maize store
 * with a queue behind him will not resolve a validation error; he will write it
 * on paper and it will never reach the system. So every rule below produces a
 * label, and the record is stored either way.
 *
 * Flags are stored in a column beside the record, never merged into it — the
 * bytes read back are the bytes that were asserted. See
 * docs/decisions/0005-record-storage-layout.md.
 */

/**
 * Upper bounds beyond which a single record's quantity is worth a second look.
 *
 * These are **placeholders**. None of them has been checked against a real
 * delivery book; the spec's own validation exercise (§13) has not been run.
 * They are set high enough that an ordinary smallholder delivery never trips
 * one, so the flag means "look at this", not "this is wrong".
 */
const IMPLAUSIBLE_ABOVE: Record<RawUnit, number> = {
  kg: 100_000,
  tonne: 100,
  gram: 1_000_000,
  litre: 100_000,
  bag: 2_000,
  sack: 2_000,
  basin: 5_000,
  tin: 10_000,
  basket: 5_000,
  bunch: 5_000,
  heap: 5_000,
  wheelbarrow: 1_000,
  jerrycan: 5_000,
  piece: 100_000,
};

/** Tolerance for field-device clock skew before `occurred_at` looks wrong. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Spec §9.1 calls for a configurable threshold. This is a constant until there
 * is a real number to configure — the spec's own validation exercise (§13) has
 * not been run, so any value in a config file would be this guess with extra
 * ceremony. 2% is roughly the moisture loss a coop would not remark on.
 */
const MASS_BALANCE_TOLERANCE = 0.02;

export interface QualityContext {
  type: string;
  /** The parsed record: envelope and body together. */
  document: Record<string, unknown>;
  /** How the delegation behind `on_behalf_of` was granted, when there is one. */
  delegationBasis?: string | null;
}

export function qualityFlags(context: QualityContext): string[] {
  const flags = new Set<string>();

  flagTimestamps(context.document, flags);
  flagDelegation(context, flags);
  for (const quantity of findQuantities(context.document)) {
    flagQuantity(quantity, flags);
  }
  if (context.type === 'delivery' || context.type === 'custody_transfer') {
    flagTransfer(context.document, flags);
  }
  if (context.type === 'lot') flagMassBalance(context.document, flags);

  return [...flags].sort();
}

function flagTimestamps(
  document: Record<string, unknown>,
  flags: Set<string>,
): void {
  const occurredAt = Date.parse(String(document['occurred_at']));
  const recordedAt = Date.parse(String(document['recorded_at']));
  if (Number.isNaN(occurredAt) || Number.isNaN(recordedAt)) return;

  if (occurredAt > recordedAt + CLOCK_SKEW_TOLERANCE_MS) {
    // Field devices run for days offline and their clocks drift. This is a
    // signal about the device, not a reason to lose the record.
    flags.add('occurred_after_recorded');
  }
}

function flagDelegation(context: QualityContext, flags: Set<string>): void {
  if (context.document['on_behalf_of'] == null) return;

  flags.add('delegated_authority');

  // Spec §5.3: membership-derived authority is weaker evidence than an
  // individual grant and must be labelled as such wherever it is surfaced.
  if (context.delegationBasis === 'organisational_bylaw') {
    flags.add('delegated_by_organisational_bylaw');
  }
}

interface QuantityLike {
  raw_value: number;
  raw_unit: RawUnit;
  normalized_kg: number | null | undefined;
  measurement_method: MeasurementMethod;
}

function flagQuantity(quantity: QuantityLike, flags: Set<string>): void {
  if (quantity.normalized_kg == null) {
    // Spec §3.2: no conversion exists for this unit, commodity and region yet.
    // The raw value is preserved and can be re-derived once one does.
    flags.add('quantity_not_normalized');
  }

  if (!isUnderwritable(quantity.measurement_method)) {
    // Spec §3.3: below `coop_weighed`, a lender will not underwrite it.
    flags.add('measurement_below_underwritable');
  }

  const bound = IMPLAUSIBLE_ABOVE[quantity.raw_unit];
  if (bound !== undefined && quantity.raw_value > bound) {
    flags.add('quantity_implausible_high');
  }
}

function flagTransfer(
  document: Record<string, unknown>,
  flags: Set<string>,
): void {
  const from = document['from_party'];
  const to = document['to_party'];

  if (typeof from === 'string' && from === to) {
    flags.add('delivery_parties_identical');
  }

  const confirmedBy = document['counterparty_confirmed_by'];
  if (
    typeof confirmedBy === 'string' &&
    confirmedBy !== from &&
    confirmedBy !== to
  ) {
    // Spec §5.11: a confirmation is evidence because it comes from the other
    // side of the transfer. From anyone else it is not a confirmation.
    flags.add('confirmation_by_uninvolved_party');
  }
}

/**
 * Spec §9.1. `Σ(inputs) − declared − losses = discrepancy`. Store it, never
 * refuse the record: a coop that is consistently 3% short is information, and a
 * system that rejects entries which do not reconcile gets bypassed, leaving you
 * with neither the record nor the discrepancy.
 *
 * Only the inputs side is knowable here. Outputs accumulate as deliveries and
 * transfers are recorded later, so the running balance is a read-time question
 * this flag does not answer.
 */
function flagMassBalance(
  document: Record<string, unknown>,
  flags: Set<string>,
): void {
  const components = document['composed_of'];
  if (!Array.isArray(components) || components.length === 0) return;

  const declared = normalizedKg(document['quantity']);
  if (declared === null) return;

  let inputs = 0;
  for (const component of components) {
    const kg = normalizedKg(
      (component as Record<string, unknown> | null)?.['quantity'],
    );
    // One unconvertible component makes the whole sum meaningless.
    if (kg === null) return;
    inputs += kg;
  }

  if (inputs === 0) return;
  if (Math.abs(inputs - declared) / inputs > MASS_BALANCE_TOLERANCE) {
    flags.add('mass_balance_discrepancy');
  }
}

function normalizedKg(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const kg = (value as Record<string, unknown>)['normalized_kg'];
  return typeof kg === 'number' ? kg : null;
}

/** Quantities are nested at different depths per entity, so walk for them. */
function findQuantities(value: unknown, found: QuantityLike[] = []): QuantityLike[] {
  if (Array.isArray(value)) {
    for (const item of value) findQuantities(item, found);
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['raw_value'] === 'number' &&
    typeof candidate['raw_unit'] === 'string' &&
    typeof candidate['measurement_method'] === 'string'
  ) {
    found.push(candidate as unknown as QuantityLike);
  }

  for (const nested of Object.values(candidate)) findQuantities(nested, found);
  return found;
}
