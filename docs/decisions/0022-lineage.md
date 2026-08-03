# 0022 — Lineage: staleness, cycles, and who may correct

## Status

Accepted.

## Context

Spec §8 gives five rules for how records supersede one another. Three of them
were only half built: staleness of dependent inferences was not computed at all,
cycles were assumed impossible rather than refused, and correction rights
stopped at the original claimant.

## Decision

### Staleness is derived, never stored

§8 rule 5 says superseding an observation does not invalidate the inferences
computed from it — it marks them stale for the owning model to re-run.

There is no way to mark an existing row in an append-only log. The only thing we
could write is a second record asserting that the first is stale, which is a
fact about our bookkeeping rather than about the world, and it would be wrong
the moment the input moved again.

So an inference is stale **iff any record it depends on has been superseded or
retracted**, computed at read time and attached to the view as
`RecordView.staleness`. Same shape as the balance and settlement summaries.

Three details that are not incidental:

**The reason is not one thing.** A superseded input means a newer value exists
and the model can recompute. A retracted input means the input is *gone* and
recomputation may be impossible. `stale_reason` reports `input_superseded`,
`input_retracted`, or both, because the operational response differs: one is a
job to re-run, the other is a conversation.

**A client-supplied `stale` is discarded on ingest**, alongside `recorded_at`
and `superseded_by`. A client able to assert `stale: false` can assert its way
out of the re-run the superseded input exists to force.

**The dependency lookup is generic over any field naming a record.**
`DEPENDENCY_FIELDS` is `['inputs', 'validated_by']`. `validated_by` is there now
rather than when work order G lands, because a retracted validator no longer
settles anything and the verdict rests on it exactly as the prediction rests on
its inputs. G adds nothing here.

One query per page, not per inference. `dependencyStatus` takes every dependency
id across the whole page and returns one map. It looks in both `facts.record`
and `inference.record`: an inference built on another inference is a real shape,
and looking only at the fact log would report those dependencies as unresolved —
which reads as *we could not check* and would hide exactly the compounding error
`inference_depth` exists to expose.

### Cycles are refused at ingest, and depth is bounded

§8 rule 3 permits chains and rejects cycles. A cycle would make a read that
resolves to the tip loop forever.

Worth recording what the tests found: **a cycle cannot be built today.**
`supersedes` must name a record already in the log, and a fresh record's id is by
definition not in the log, so every edge points from a new node to an older one
and the graph is always a DAG. An A→B→C→A attempt is currently caught as an
`id_conflict` in `appendIfAbsent`, not as a cycle. The one-link case is caught
earlier still, by the envelope schema's own `a record cannot supersede itself`
refinement, and surfaces as `malformed_record`.

The explicit check was added anyway. That argument depends on two separate
methods continuing to hold, in two different files, and an emergent property
nobody tests is a property that decays. `checkChainShape` walks the existing
ancestry before accepting the link and makes the guarantee local.

The same walk bounds depth. A 10,000-link chain is a denial of service against
every default read, not just reads of that record. `SUPERSESSION_MAX_DEPTH`
defaults to 64 and is configuration rather than a constant, for two reasons: an
instance that meets a legitimately long chain can raise it without a deploy, and
the ingest-side check and the read-side walks cannot drift apart.

Approaching the bound **flags rather than rejects**, per P6:
`supersession_chain_deep` appears from 75% of the limit. Only crossing it is
refused, and the message says what the limit is.

### A correction right can be delegated

§8 rule 1 says only the original `asserted_by`, *or a party holding an explicit
correction right over them*, may supersede. Only the first half existed.

The second half is a Delegation whose `scope` covers the record type — a
cooperative correcting a member's delivery when the member is unreachable, which
is the common real case. It resolves exactly as ingest already resolves
delegation for `on_behalf_of`: in scope, in date, not revoked.

**The delegation must be named on the correction.** The kernel does not search
the log for some grant that happens to authorise the writer. If it did, a
correction's authority would depend on what else had been written since, and
nobody could audit that.

**Weaker authority stays visible.** A correction made under
`organisational_bylaw` carries `corrected_under_organisational_bylaw` as well as
`corrected_under_delegation`, so a lender walking the chain can see which link
rests on a bylaw and which on the farmer's own word without fetching the
delegation.

## Consequences

`checkRetraction` was **not** extended, and that is a known inconsistency. Its
own comment says a retraction has the same authority requirement as a
correction, so correction rights reaching further than retraction rights makes
them diverge. It was left because the delegation `scope` for a Retraction is
genuinely ambiguous — scope is per record type (open decision D7), and for a
retraction the record's `type` is `retraction` while its `target` is a
`delivery`. For supersession those two are identical, so the question never
arose. Flagged rather than guessed; it needs D7 settled.

Reading the chain of a delegated correction is currently refused by the consent
stub for any real two-party delivery. `subjectsOf('delivery')` yields
`from_party`, `to_party`, `lot` and `fulfils`, and decision 0009's stub allows a
self-read only when the requester is the *only* subject. That is a property of
the stub, not of lineage, but it means the bylaw label is only reachable today
on single-party records. It resolves when consent does.

`staleness` is attached to the view and the stored `stale` field in an
inference's body is left untouched, per the work order. That means a payload can
read `stale: false` while `view.staleness.stale` is true. `Lot.custodian` is
overwritten in place for the same class of reason — a schema field the kernel
owns and the stored value goes stale — and the two should probably agree. Open.
