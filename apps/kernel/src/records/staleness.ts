/**
 * Spec §8 rule 5. Whether the ground has moved under an inference.
 *
 * The rule says superseding an observation "sets `stale`" on the inferences
 * that used it. Setting it is not available to us: the log is append-only, so
 * the only way to mark an existing row would be to write a second record
 * claiming the first is stale — which is a fact about our bookkeeping, not
 * about the world, and would then itself need maintaining when the input was
 * corrected again.
 *
 * So it is derived, on every read, from the state of the inputs. The stored
 * `stale` boolean is therefore meaningless and is never read; see
 * `DEPENDENCY_FIELDS` for why it is also never written.
 */

/**
 * Inference body fields that name other records.
 *
 * Generic rather than hard-coded to `inputs` because `validated_by` names
 * records too — a March prediction linked in August to the deliveries that
 * settled it. A validator that was retracted no longer settles anything, and
 * the verdict rests on it exactly as the prediction rests on its inputs.
 *
 * Work order G adds nothing here. It populates `validated_by`, which this
 * already reads.
 */
export const DEPENDENCY_FIELDS = ['inputs', 'validated_by'] as const;

/**
 * Why an inference no longer stands on what it was computed from.
 *
 * The two are not interchangeable. A superseded input means a better value
 * exists and the model can simply re-run. A retracted input means the input is
 * gone — the claim was withdrawn, not corrected — and there may be nothing to
 * re-run against. A model scheduler that treats them alike will queue work it
 * cannot complete.
 */
export type StaleReason = 'input_superseded' | 'input_retracted';

/** Whether a record an inference depends on has moved since it was computed. */
export interface DependencyStatus {
  superseded: boolean;
  retracted: boolean;
}

export interface Staleness {
  stale: boolean;
  /** Both, where both apply. Ordered so the value is comparable. */
  reasons: StaleReason[];
  /** The dependencies that caused it, so a re-run knows what to re-fetch. */
  superseded_inputs: string[];
  retracted_inputs: string[];
  /**
   * A named dependency is not in this corpus at all. It is not staleness — the
   * inference may simply have arrived before its inputs — but a caller told
   * only `stale: false` would read that as "verified against every input".
   */
  unresolved_inputs: string[];
}

/** Every record id an inference body names, deduplicated, in field order. */
export function dependenciesOf(body: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const value = body[field];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.length > 0) ids.add(entry);
    }
  }
  return [...ids];
}

export function resolveStaleness(
  dependencies: readonly string[],
  status: ReadonlyMap<string, DependencyStatus>,
): Staleness {
  const superseded: string[] = [];
  const retracted: string[] = [];
  const unresolved: string[] = [];

  for (const id of dependencies) {
    const found = status.get(id);
    if (found === undefined) {
      unresolved.push(id);
      continue;
    }
    if (found.superseded) superseded.push(id);
    if (found.retracted) retracted.push(id);
  }

  const reasons: StaleReason[] = [];
  if (superseded.length > 0) reasons.push('input_superseded');
  if (retracted.length > 0) reasons.push('input_retracted');

  return {
    stale: reasons.length > 0,
    reasons,
    superseded_inputs: superseded,
    retracted_inputs: retracted,
    unresolved_inputs: unresolved,
  };
}
