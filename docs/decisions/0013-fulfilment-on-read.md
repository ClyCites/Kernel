# 0013 — Fulfilment is summed on read, never stored

## Status

Accepted.

## Context

`Delivery.fulfils` points at an `Agreement`. Someone eventually has to ask the
obvious question — *how much of this agreement has actually arrived?* — and the
obvious implementation is a `delivered_kg` column on the agreement that ingest
increments.

That column would be wrong within a week. Deliveries are superseded when a weight
is corrected and retracted when they were logged against the wrong farmer, so any
counter needs a decrement path, and a decrement path in an append-only store is a
second, mutable copy of the truth that nothing can audit. Offline sync makes it
worse: the increment order is whatever order the phones happened to reconnect in.

## Decision

**The kernel computes fulfilment from the delivery rows on every read.** It is
attached to the agreement's `RecordView` as `fulfilment` and stored nowhere.

Aggregation happens in SQL — `count`, `sum`, and two filtered counts grouped by
`fulfils` — so a busy agreement does not pull every delivery across the wire, and
a page of agreements costs one query rather than one per agreement.

Superseded and retracted deliveries are excluded, using the same predicates the
rest of the read path uses. A corrected delivery counts once, at the corrected
weight. A retracted one does not count at all.

## Three things the shape insists on saying

**`unconvertible` and `incomplete`.** If a delivery's quantity never reached
kilograms, it contributes nothing to the sum. Reporting `delivered_kg` alone
would then quietly understate, and a lender reading "62% fulfilled" would have no
way to know the real figure is higher by an unknown amount. `incomplete` says the
total is a floor.

**`committed_kg` may be null.** If the agreement's own `quantity_committed` was
never normalized, the shortfall is unknowable, not zero. `outstanding_kg` is null
rather than misleading.

**`outstanding_kg` is not clamped.** Over-delivery reads as a negative number.
Clamping at zero would hide the single most interesting thing an agreement can
tell you.

`confirmed` is counted separately from `deliveries` because arrival and agreement
are different facts, and the gap between them is exactly what a lender is buying.

## Consequences

This is display-time aggregation over records the caller can already see, which
is the same boundary decision 0009's consent guard draws — `derive()` runs after
`guard()`, so nothing is summed for a caller who was not entitled to the rows.

It is deliberately not a balance and not an obligation. It sums physical
quantities against a stated commitment. Money stays out (invariant 6), and B5's
obligation summing is a separate question answered separately.

If this becomes slow, the answer is a rollup keyed on the agreement that can be
rebuilt from the log at any time, not a counter that cannot.
