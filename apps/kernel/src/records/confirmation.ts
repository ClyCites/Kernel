/**
 * Whether the other side of a delivery said it happened.
 *
 * Read from the `delivery_confirmation` records that name this exact delivery
 * id, every time it is asked for. There is no timestamp on the Delivery and
 * there must never be one again: a field the seller can set on their own
 * record is the seller's opinion of the buyer's agreement.
 *
 * Version-specific by construction. A correction is a new record with a new
 * id, so confirmations of the old weight do not follow it — which is right.
 * Nobody confirmed the new weight.
 */

/** One confirmation record, flattened. */
export interface ConfirmationRow {
  delivery: string;
  confirming_party: string;
  /** Who physically asserted it. Differs from `confirming_party` under delegation. */
  asserted_by: string;
  delegated: boolean;
  /** Delegation resting on a coop bylaw rather than on the party's own act. */
  by_bylaw: boolean;
  channel: string;
  occurred_at: string;
}

export interface Confirmation {
  confirmed: boolean;
  confirmed_at: string | null;
  confirmed_by: string | null;
  channel: string | null;
  /**
   * The confirming party confirmed it themselves. This is the field a lender
   * should be reading: a delegated confirmation is somebody asserting that the
   * counterparty agrees, which is the same shape of claim as the delivery
   * itself and carries no independent weight.
   */
  independent: boolean;
  delegated: boolean;
  by_bylaw: boolean;
  count: number;
}

export const UNCONFIRMED: Confirmation = {
  confirmed: false,
  confirmed_at: null,
  confirmed_by: null,
  channel: null,
  independent: false,
  delegated: false,
  by_bylaw: false,
  count: 0,
};

/**
 * The first confirmation is the one that counts — confirming is an act, and
 * repeating it does not make it truer. A direct confirmation is preferred over
 * a delegated one regardless of order, because the question a lender is asking
 * is whether the counterparty themselves ever said so.
 */
export function resolveConfirmation(rows: readonly ConfirmationRow[]): Confirmation {
  if (rows.length === 0) return UNCONFIRMED;

  const ordered = [...rows].sort(
    (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
  );
  const chosen = ordered.find((row) => !row.delegated) ?? ordered[0];
  if (chosen === undefined) return UNCONFIRMED;

  return {
    confirmed: true,
    confirmed_at: chosen.occurred_at,
    confirmed_by: chosen.confirming_party,
    channel: chosen.channel,
    independent: !chosen.delegated,
    delegated: chosen.delegated,
    by_bylaw: chosen.by_bylaw,
    count: rows.length,
  };
}
