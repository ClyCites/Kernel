# 0014 — Mass balance is reconciled across the custody sequence

## Status

Accepted. Extends the ingest-time check that shipped with phase 4.

## Context

Spec §9.1 asks for `Σ(inputs) − declared − losses = discrepancy`. What shipped
first was the part knowable inside a single record: a Lot whose declared weight
disagrees with the sum of its `composed_of` components gets a
`mass_balance_discrepancy` flag at ingest. That is a real check — it catches bad
commingling arithmetic — but it is a statement about one record at one moment,
and it never mentions losses, because at ingest there are none yet.

The balance worth having is the lifecycle one. The schema already says where to
look, in its own note on `CustodyTransfer`: *the gap between two custody
transfers is exactly where losses occur*, and `quantity` there is *measured at
the point of transfer, not inherited from the lot*.

That makes the custody sequence a series of independent weighings of the same
produce, by different parties, with different incentives. Reconciling it is the
single cheapest fraud and shrinkage signal in the record layer.

## Decision

**The kernel computes a lot's balance at read time, over its custody sequence.**
It is attached to the lot's `RecordView` as `balance` and stored nowhere, for
the reasons decisions 0002 and 0013 already give.

The walk carries a running holding weight:

1. Open at the lot's own `quantity.normalized_kg`.
2. At each transfer, subtract the `loss.declared` Observations that occurred
   since the previous hand-over, and compare the result to what the transfer
   actually weighed.
3. The fresh weighing becomes the basis for the next leg.
4. Losses declared after the last hand-over still deplete the lot.

`unexplained_kg = opening − closing − declared losses`, which by construction
equals the sum of the leg discrepancies.

**Losses are Observations, per decision 0011.** They arrive with an author, a
time and their own retraction path, so a loss can be walked back without editing
the lot, and a loss declared on the fifth does not retroactively excuse a
shortfall measured on the second.

## Things the shape insists on saying

**Each leg is judged as well as the total.** A lot that loses 8% between the
farmer and the coop and gains it back between the coop and the warehouse nets to
zero. Reporting only the total would call that clean. It is not clean; it is two
weighings that cannot both be right.

**Mass appearing is reported the same as mass leaving.** A negative discrepancy
is not clamped. Produce that grows in transit is at least as interesting as
produce that shrinks.

**`incomplete` is separate from `breached`.** If a transfer or a loss could not
be read in kilograms, the arithmetic is partial, and a clean-looking balance on
a partial ledger means nothing. A caller must be able to tell "this reconciles"
from "this could not be checked".

**A loss that never normalized counts as null, not zero.** Zero would flatter
the lot.

## The threshold is configurable

`MASS_BALANCE_TOLERANCE`, defaulting to `0.02`. The default is a guess — roughly
the moisture loss a coop would not remark on — and remains a guess until the
field validation in §13 produces a real number. It is an environment setting so
that number can be adopted without shipping code, and so different deployments
can run different thresholds while it is being established.

It is deliberately a single global value and not per-commodity. Per-commodity
thresholds are a registry table, and inventing one before there is a measured
number to put in it would be the `assumed_default` problem again with more
machinery.

## Consequences

The ingest-time `composed_of` check stays. It answers a different question — did
this lot's inputs add up when it was formed — and it is order-independent and
correct at write time, so there is no reason to move it.

A discrepancy is never a rejection. A coop that is consistently 3% short is
information; a system that refuses entries which fail to reconcile gets bypassed,
and then you have neither the record nor the discrepancy.

Deliveries are not in the ledger. A `Delivery` against a lot plainly removes mass
from it, but the schema does not say whether a delivery drains the lot or is one
of several partial draws, and guessing would produce a confident wrong number.
Leaving it out understates depletion rather than inventing it. This is a §13
schema-shape question.

`declaredLossesFor` and `custodyTransfersFor` run once per page, not once per
lot.
