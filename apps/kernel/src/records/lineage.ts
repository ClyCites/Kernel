/**
 * Spec §8 rule 3. Chains are permitted, cycles are rejected, and depth is
 * bounded.
 *
 * The bound is the part that is easy to leave out. Chains are resolved to their
 * tip on every default read, so one pathological chain is not a problem for the
 * record it belongs to — it is a problem for every read of every other record
 * that happens to share the page.
 */

/** See `SUPERSESSION_MAX_DEPTH` in config.ts for why this is a parameter. */
export const DEFAULT_SUPERSESSION_MAX_DEPTH = 64;

/**
 * The fraction of the bound at which a chain starts being reported.
 *
 * Flagging before refusing matters here more than it looks. A chain that hits
 * the bound is refused, and P6 says a field officer cannot fix a refusal — so
 * the flag has to appear while there is still room for somebody to notice that
 * a record has been corrected fifty times and ask why.
 */
export const CHAIN_DEEP_AT = 0.75;

export interface ChainDepth {
  /** The depth the new correction would sit at. 1 is the first correction. */
  depth: number;
  /** At or past the bound. Refused. */
  exceeded: boolean;
  /** Approaching the bound. Flagged, and stored. */
  deep: boolean;
}

export function chainDepth(
  ancestorDepth: number,
  maxDepth: number,
): ChainDepth {
  const depth = ancestorDepth + 1;
  return {
    depth,
    exceeded: depth >= maxDepth,
    deep: depth >= Math.floor(maxDepth * CHAIN_DEEP_AT),
  };
}
