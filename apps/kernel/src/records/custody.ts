/**
 * Who currently holds a lot.
 *
 * `Lot.custodian` is a field on a record that never changes, in a store where
 * nothing can be updated. The schema is explicit about what that means —
 * "derived convenience field, authoritative history is CustodyTransfer" — but
 * until now the kernel served the stored value, which is correct only until the
 * first transfer and silently wrong forever after.
 *
 * So it is computed. Same reasoning as `superseded_by` in decision 0002: a
 * derived answer is always right, a stored one is right until the next record
 * arrives.
 */

export interface CustodyTransferLink {
  id: string;
  lot: string;
  from_party: string;
  to_party: string;
  occurred_at: string;
  /** Under an unresolved correction, so neither version may move the lot. */
  forked: boolean;
}

export interface Custody {
  /** Who holds it now. */
  custodian: string;
  /** What the lot record claimed at creation. Kept so nothing is lost. */
  asserted: string;
  /** When the current holder took it. Null when nothing has moved. */
  as_of: string | null;
  transfers: number;
  /**
   * A transfer in the sequence was corrected two ways at once and was left out
   * of the walk, so `custodian` is where the lot got to before the dispute and
   * not necessarily where it is. See decision 0021.
   */
  forked: boolean;
  /**
   * A transfer moved the lot from someone who was not holding it. Two people
   * transferring the same lot at once presents this way too — both are a chain
   * that does not link up, and both need a human.
   */
  broken: boolean;
}

/**
 * Transfers must arrive ordered. The last `to_party` wins; a `from_party` that
 * does not match the current holder breaks the chain but does not stop the
 * walk, because the later transfers still happened and a reader needs to see
 * where the lot ended up as well as that the trail is bad.
 */
export function resolveCustody(
  assertedCustodian: string,
  allTransfers: readonly CustodyTransferLink[],
): Custody {
  const transfers = allTransfers.filter((t) => !t.forked);
  let holder = assertedCustodian;
  let asOf: string | null = null;
  let broken = false;

  for (const transfer of transfers) {
    if (transfer.from_party !== holder) broken = true;
    holder = transfer.to_party;
    asOf = transfer.occurred_at;
  }

  return {
    custodian: holder,
    asserted: assertedCustodian,
    as_of: asOf,
    transfers: transfers.length,
    forked: transfers.length !== allTransfers.length,
    broken,
  };
}
