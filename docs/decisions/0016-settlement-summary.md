# 0016 — Settlements are summarised per obligation, and never per party

## Status

Accepted.

## Context

An `Obligation` records money owed. A `SettlementReference` records that it was
settled *somewhere else* — on MTN, on Airtel, at a bank. The kernel holds no
funds and is not the ledger of record for any of it.

Someone will ask what an obligation's settlement position is, and that question
has an answer the kernel can give honestly. The adjacent question — what is a
party owed in total — has an answer the kernel must refuse to give, because that
number is a balance, and a system that shows balances is a system the National
Payment Systems Act treats as holding funds.

The gap between those two questions is narrow enough that the shape of the code
has to do the work, not a comment.

## Decision

**Summarise settlements for one obligation at a time.** `RecordView.settlement`
is attached to obligations only, computed on read, stored nowhere. There is no
repository method, no service method and no route that takes a party and returns
money.

Four things the summary is careful about:

**Verification statuses are never added together.** `referenced_minor` is a map
keyed on `verification_status`, not a total. An `asserted` settlement is one
side's claim that they paid; a `provider_verified` one is evidence from the rail
itself. Collapsing them into a single figure launders the first into the second,
and that distinction is the entire value of the repayment signal. `disputed` is
surfaced separately again.

**Currencies are never converted.** A settlement denominated in something other
than the obligation's currency is counted in `currency_mismatch` and excluded
from the sums. Adding across currencies would require an exchange rate the
kernel does not have and would have to invent.

**Arithmetic is integer minor units end to end.** `Money.amount_minor` is an
integer for the reason the schema gives, and this is exactly the aggregation
where binary floating point error accumulates silently. The SQL sum is `bigint`,
carried as text and parsed once.

**The remainder is called `unreferenced_minor`.** Not `outstanding`, not
`balance`, not `owed`. The kernel does not know whether money moved; it knows
whether a record exists claiming it did. The name should say only that. It is
not clamped at zero, so over-referencing shows as a negative rather than
disappearing.

## Consequences

Superseded and retracted settlements are excluded, as everywhere else. A
corrected settlement references once, at the corrected amount.

Two tests hold the line rather than a convention: one asserts no method on
`RecordRepository` is named anything matching
`balance|wallet|float|owed|payable|receivable`, and one asserts the summary
carries no party-shaped field. They fail the moment someone adds
`partyBalance()`, which is the only form this mistake takes.

The lender-facing view in the seed work builds on this per obligation, listing
them, and does not total them. A list of obligations with their settlement
positions is a credit file. One number at the bottom is a balance sheet.
