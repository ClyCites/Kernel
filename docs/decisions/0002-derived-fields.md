# 0002 — `superseded_by` and `stale` are derived, not stored

**Status:** accepted
**Date:** 2026-08-02

## Context

The envelope (spec §4) carries `superseded_by`, described as "derived;
maintained by the kernel". Spec §8 rule 5 says superseding an observation sets a
`stale` flag on any Inference listing it in `inputs`.

Read literally as storage, both are UPDATEs against records that already exist —
in direct tension with invariant 1. The brief anticipates this and permits a
narrowly-scoped exception:

> The one legitimate exception is the kernel-maintained `superseded_by`
> back-reference. Handle it with a separate, narrowly-scoped mechanism (a
> trigger or a dedicated privileged role) and document why.

## Decision

**Neither field is stored. Both are derived at read time.**

- `superseded_by` is the reverse of `supersedes`, which is already indexed
  (`facts_record_supersedes_idx`). A record is superseded if some other record
  points at it.
- An Inference is stale if any id in its `inputs` has a superseding record.

There is therefore no exception to carve out, no trigger, no `SECURITY DEFINER`
function, and no second privileged role. `kernel_app` holds `INSERT` and
`SELECT` and the record tables have no UPDATE path at all — not a discouraged
one, an impossible one.

`facts.record` has no `superseded_by` column; a test asserts its absence.

## Why this is better than the trigger

Spec §8 rule 4 requires that **concurrent supersession of the same record
produces a fork, surfaced for human resolution rather than auto-merged**. Two
officers correcting the same delivery to different weights is a real dispute.

A stored `superseded_by` column has room for one value. The second corrector
either overwrites the first — silently picking a winner, which rule 4 forbids —
or the write fails, which loses a record. The derived form has neither problem:
two rows with the same `supersedes` value *is* the fork, already visible to the
query that resolves the chain.

The same argument applies to `stale`: it is a function of the current state of
the inputs, and computing it is always correct, whereas a stored flag is correct
only until the next correction arrives.

## Consequences

- One extra index lookup per record on read paths that report supersession
  state. The index is on a nullable column with a partial predicate, so it is
  small.
- API responses expose `superseded_by` and `stale` exactly as the schema
  describes them; consumers cannot tell the difference and should not need to.
- Deep chains cost one recursive CTE rather than one lookup. Chains are expected
  to be short (a correction, occasionally a correction of a correction).
