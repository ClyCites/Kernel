# 0021 — A forked record is counted in nothing

## Status

Accepted.

## Context

Spec §8 rule 4 allows two people to correct the same record. The kernel surfaces
that as `superseded_by` with more than one entry and refuses to pick a winner,
which is right: two officers weighing the same delivery at 1,380kg and 1,416kg
have produced a dispute, and a record layer that silently resolves it has
destroyed the only evidence that there was one.

Every derived view, however, sums *the tip* of each chain, and a fork has two
tips. `deliveryTallies`, `settlementGroups`, `custodyTransfersFor` and
`declaredLossesFor` all filtered on `not superseded`. Under a fork A→{B,C}, A is
excluded because it has superseders and **both B and C survive the filter**. The
disputed delivery above was contributing **2,796kg** to fulfilment — not one
weight or the other, but their sum.

That is worse than any answer we might have chosen deliberately. A number
inflated by a dispute looks exactly like a number produced by a larger delivery,
and nothing in the payload said otherwise.

## Decision

**Count neither branch, and mark the derivation incomplete.**

A record is *forked* when it descends, through any number of supersession links,
from a record that has more than one superseder in the same dataset. Not just
the two records that opened the fork: correcting one branch does not resolve the
fork it hangs off, so every record below an unresolved fork is unusable for
arithmetic. The predicate is a single recursive walk, written once in
`record.repository.ts` as `FORKED` alongside `SUPERSEDED` and `RETRACTED`, so no
future query can forget it.

Forked records are counted and reported, never summed:

| View | Excluded from | Reported as |
| --- | --- | --- |
| `Fulfilment` | `delivered_kg`, `deliveries`, `confirmed`, `unconvertible` | `forked`, `incomplete` |
| `SettlementSummary` | `referenced_minor`, `references` | `forked`, `incomplete` |
| `MassBalance` | the leg sequence and the declared losses | `incomplete` |
| `Custody` | the transfer walk | `forked` |

`incomplete` is the flag that already exists on `MassBalance` and `Fulfilment`,
meaning *a figure could not be read, so the arithmetic is partial*. A fork is
that condition arriving by a different route, and reusing the flag means every
consumer that already handles an unweighable transfer handles a disputed one
without changing.

## Alternatives rejected

**Count the lower of the two, flagged.** This has the kernel pick a winner. It
has no basis to. "Lower" is not conservatism — it is a guess that happens to
favour the buyer, and in the output it is indistinguishable from a genuine
1,380kg delivery. The flag would be the only thing separating a measured fact
from a coin toss, and flags get dropped on the way to a screen.

**Refuse to derive until the fork is resolved.** One disputed record then
poisons a whole page of otherwise sound arithmetic. That is rejecting rather
than flagging, which is P6 in spirit if not in letter, and it gives the party
who wants a number an incentive to make the dispute disappear.

## Consequences

A fork makes a total go *down*, not up, and the reader is told why. That is the
same direction of error as an unconvertible delivery: `delivered_kg` is a floor,
and any percentage taken from it understates. Understating is the safe direction
for a lender-facing figure.

`Custody.custodian` under a fork is where the lot got to before the dispute, not
necessarily where it is. `Custody.forked` says so. It is deliberately not folded
into `broken`, which means something different — a chain that does not link up.

The recursive walk runs per candidate row. It is bounded by chain depth, which
decision 0022 caps at `SUPERSESSION_MAX_DEPTH`, and forks are rare, so in
practice it terminates at the first link for almost every record. If it ever
shows up in a profile the fix is a materialised fork set, not a cheaper
predicate.

Nothing about this stores anything. A fork is resolved by retracting one of the
two competing corrections — the retracted branch stops counting towards the
fork, and everything below the surviving one becomes countable again on the next
read, with no backfill. That is the only resolution path, and it is deliberate:
the alternative is a merge, and a merge is an edit.
