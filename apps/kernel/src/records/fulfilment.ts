/**
 * How much of an Agreement has actually been delivered.
 *
 * Summed from the deliveries that point at it, every time it is asked for.
 * There is no counter on the Agreement and there must never be one: a stored
 * total is a second place for the truth to live, and the moment a delivery is
 * corrected or retracted the counter is wrong with no way to tell.
 */

/** What the delivery rows add up to. Counts, not judgements. */
export interface DeliveryTally {
  deliveries: number;
  confirmed: number;
  /** Deliveries whose quantity never reached kilograms. */
  unconvertible: number;
  /** Deliveries under an unresolved correction, added to nothing. See 0021. */
  forked: number;
  delivered_kg: number;
}

export interface Fulfilment extends DeliveryTally {
  /** From the Agreement's own `quantity_committed`. Null if unnormalized. */
  committed_kg: number | null;
  /** Negative when more arrived than was committed. Null if either side is unknown. */
  outstanding_kg: number | null;
  over_delivered: boolean;
  /**
   * True when at least one delivery could not be converted or is forked, so
   * `delivered_kg` is a floor rather than a total. Any percentage taken from it
   * understates.
   */
  incomplete: boolean;
}

export const EMPTY_TALLY: DeliveryTally = {
  deliveries: 0,
  confirmed: 0,
  unconvertible: 0,
  forked: 0,
  delivered_kg: 0,
};

export function resolveFulfilment(
  committedKg: number | null,
  tally: DeliveryTally,
): Fulfilment {
  const incomplete = tally.unconvertible > 0 || tally.forked > 0;
  const outstanding =
    committedKg === null ? null : committedKg - tally.delivered_kg;

  return {
    ...tally,
    committed_kg: committedKg,
    outstanding_kg: outstanding,
    // An unconvertible or forked delivery can only push the total up, so a
    // shortfall is still uncertain — but an overage already established is real.
    over_delivered: outstanding !== null && outstanding < 0,
    incomplete,
  };
}
