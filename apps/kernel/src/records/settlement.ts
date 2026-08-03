/**
 * Spec §5.13–5.14. What settlement records say about one obligation.
 *
 * This is display-time arithmetic over a single obligation and nothing else.
 * There is deliberately no function here that takes a party and returns money.
 * Summing every obligation a party is owed produces a number a reasonable
 * person would call a balance, and a system that shows balances is a system
 * regulators treat as holding funds. Invariant 6 is not a preference.
 *
 * Amounts stay in integer minor units end to end. Binary floating point cannot
 * represent decimal currency and the error accumulates silently across exactly
 * this kind of aggregation.
 */

/** One `(currency, verification_status)` group of settlements. */
export interface SettlementGroup {
  obligation: string;
  currency: string;
  verification_status: string;
  records: number;
  amount_minor: number;
  /** Under an unresolved correction, so the amount is added to nothing. */
  forked: boolean;
}

export interface SettlementSummary {
  /** The obligation's own currency. Only settlements in it are counted. */
  currency: string;
  amount_minor: number;
  references: number;
  /**
   * Kept apart by verification status, never added together. An `asserted`
   * settlement is one side's claim; a `provider_verified` one is evidence from
   * the rail. Merging them would launder the first into the second, and the
   * distinction is the entire value of the repayment signal.
   */
  referenced_minor: Record<string, number>;
  /**
   * The obligation less every reference against it, whatever its status.
   *
   * Not "outstanding" and not a balance. The kernel does not know whether money
   * moved; it knows whether a record exists claiming it did. Negative when more
   * has been referenced than was owed, which is not clamped.
   */
  unreferenced_minor: number;
  /** Settlements denominated in some other currency. Counted, never converted. */
  currency_mismatch: number;
  /** Settlements corrected two ways at once. Counted, never summed. See 0021. */
  forked: number;
  /** A settlement was left out, so `unreferenced_minor` is an upper bound. */
  incomplete: boolean;
  disputed: boolean;
}

export function summariseSettlements(
  amount: { amount_minor: number; currency: string },
  groups: readonly SettlementGroup[],
): SettlementSummary {
  const referenced: Record<string, number> = {};
  let references = 0;
  let matched = 0;
  let mismatch = 0;
  let forked = 0;
  let disputed = false;

  for (const group of groups) {
    if (group.forked) {
      forked += group.records;
      continue;
    }

    if (group.currency !== amount.currency) {
      mismatch += group.records;
      continue;
    }

    references += group.records;
    matched += group.amount_minor;
    referenced[group.verification_status] =
      (referenced[group.verification_status] ?? 0) + group.amount_minor;
    if (group.verification_status === 'disputed') disputed = true;
  }

  return {
    currency: amount.currency,
    amount_minor: amount.amount_minor,
    references,
    referenced_minor: referenced,
    unreferenced_minor: amount.amount_minor - matched,
    currency_mismatch: mismatch,
    forked,
    incomplete: forked > 0,
    disputed,
  };
}
