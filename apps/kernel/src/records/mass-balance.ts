/**
 * Spec §9.1. Where a lot's mass went.
 *
 * The interesting balance is not inside a single Lot record — that record is
 * one weighing at one moment. It is across the custody sequence: the schema's
 * own note on `CustodyTransfer` says *the gap between two custody transfers is
 * exactly where losses occur*, and every transfer re-weighs the lot, so the
 * sequence is a series of independent measurements of the same produce.
 *
 * Shrinkage between two weighings is either explained — someone recorded a
 * `loss.declared` Observation saying so — or it is not. Unexplained shrinkage
 * is the number worth surfacing. It is never a reason to refuse a record: a
 * coop that is consistently 3% short is information, and a system that rejects
 * entries which fail to reconcile gets bypassed, leaving you with neither the
 * record nor the discrepancy.
 */

/** Spec §9.1 calls for a configurable threshold. See `MASS_BALANCE_TOLERANCE`. */
export const DEFAULT_MASS_BALANCE_TOLERANCE = 0.02;

/** A re-weighing of the lot at a change of hands. */
export interface WeighedTransfer {
  id: string;
  lot: string;
  from_party: string;
  to_party: string;
  occurred_at: string;
  /** Null when the transfer's quantity never reached kilograms. */
  weighed_kg: number | null;
}

/** A `loss.declared` Observation against the lot. */
export interface DeclaredLoss {
  id: string;
  lot: string;
  occurred_at: string;
  /**
   * Null when the loss was not a normalized quantity — a category or scalar
   * observation, or a quantity whose unit has no conversion. Counting it as
   * zero would flatter the lot, so the balance is marked incomplete instead.
   */
  kg: number | null;
}

export interface BalanceLeg {
  transfer: string;
  from_party: string;
  to_party: string;
  at: string;
  /** What the lot weighed when it last changed hands, less losses declared since. */
  expected_kg: number | null;
  weighed_kg: number | null;
  declared_loss_kg: number;
  /** Positive means mass went missing. Negative means mass appeared. */
  discrepancy_kg: number | null;
  breached: boolean;
}

export interface MassBalance {
  opening_kg: number | null;
  closing_kg: number | null;
  declared_loss_kg: number;
  /** Shrinkage nobody accounted for. Equals the sum of the leg discrepancies. */
  unexplained_kg: number | null;
  tolerance: number;
  /** The whole-lot ratio breached, or any single leg did. */
  breached: boolean;
  /**
   * A weighing or a loss could not be read in kilograms, so the arithmetic is
   * partial. A clean-looking balance on an incomplete ledger means nothing.
   */
  incomplete: boolean;
  legs: BalanceLeg[];
}

export function resolveMassBalance(
  openingKg: number | null,
  transfers: readonly WeighedTransfer[],
  losses: readonly DeclaredLoss[],
  tolerance = DEFAULT_MASS_BALANCE_TOLERANCE,
): MassBalance {
  const ordered = [...losses].sort((a, b) =>
    a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0,
  );

  let incomplete = openingKg === null || ordered.some((l) => l.kg === null);
  let holding = openingKg;
  let cursor = 0;
  let anyLegBreached = false;
  const legs: BalanceLeg[] = [];

  for (const transfer of transfers) {
    let legLoss = 0;
    while (cursor < ordered.length && ordered[cursor]!.occurred_at <= transfer.occurred_at) {
      legLoss += ordered[cursor]!.kg ?? 0;
      cursor += 1;
    }

    const expected = holding === null ? null : holding - legLoss;
    const weighed = transfer.weighed_kg;
    if (weighed === null) incomplete = true;

    const discrepancy =
      expected === null || weighed === null ? null : expected - weighed;
    const breached =
      discrepancy !== null &&
      expected !== null &&
      expected > 0 &&
      Math.abs(discrepancy) / expected > tolerance;
    if (breached) anyLegBreached = true;

    legs.push({
      transfer: transfer.id,
      from_party: transfer.from_party,
      to_party: transfer.to_party,
      at: transfer.occurred_at,
      expected_kg: expected,
      weighed_kg: weighed,
      declared_loss_kg: legLoss,
      discrepancy_kg: discrepancy,
      breached,
    });

    // The fresh weighing becomes the basis for the next leg. A missing one
    // breaks the chain of arithmetic, and nothing downstream can be trusted.
    holding = weighed;
  }

  // Losses declared after the last hand-over still deplete the lot.
  let trailing = 0;
  for (; cursor < ordered.length; cursor += 1) {
    trailing += ordered[cursor]!.kg ?? 0;
  }

  const declaredLoss = ordered.reduce((sum, loss) => sum + (loss.kg ?? 0), 0);
  const closing = holding === null ? null : holding - trailing;
  const unexplained =
    openingKg === null || closing === null
      ? null
      : openingKg - closing - declaredLoss;

  return {
    opening_kg: openingKg,
    closing_kg: closing,
    declared_loss_kg: declaredLoss,
    unexplained_kg: unexplained,
    tolerance,
    breached:
      anyLegBreached ||
      (unexplained !== null &&
        openingKg !== null &&
        openingKg > 0 &&
        Math.abs(unexplained) / openingKg > tolerance),
    incomplete,
    legs,
  };
}
