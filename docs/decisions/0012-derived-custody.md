# 0012 — `Lot.custodian` is computed from the transfer chain

## Status

Accepted.

## Context

`Lot.custodian` is a required field on a record in a store with no UPDATE path.
The schema is candid about what it is — *"derived convenience field,
authoritative history is CustodyTransfer"* — but the kernel was serving the
value the client wrote at creation.

That value is correct until the first `CustodyTransfer` and silently wrong
forever after. A mutable derived field in an append-only store is not a gap in
the feature set; it is a live correctness bug, and it is the worst kind, because
the wrong answer is well-formed and confident.

## Options considered

**A projection table maintained on ingest.** A `lot_custody` table updated as
transfers arrive. Rejected: it reintroduces mutable state, needs a write path
the application role deliberately does not have, and gets the answer wrong
whenever records arrive out of order — which invariant 5 (offline default) makes
routine rather than exceptional.

**A materialised view.** Rejected for the refresh question. Either it refreshes
on write, which is the projection above with extra steps, or it refreshes on a
timer, in which case the kernel serves a custody answer that is knowably stale
and cannot say by how much.

**Compute on read.** Chosen.

## Decision

**The custody chain is walked at read time.** `ReadService` replaces the stored
`custodian` on every lot it serves with the one the transfers imply, and attaches
a `custody` object recording how it got there:

| Field | Meaning |
| --- | --- |
| `custodian` | who holds it now |
| `asserted` | what the lot record claimed at creation |
| `as_of` | when the current holder took it |
| `transfers` | how many transfers were walked |
| `broken` | a transfer moved the lot from a party who was not holding it |

This is the same reasoning as decision 0002. A derived answer is always right; a
stored one is right until the next record arrives.

Superseded and retracted transfers are excluded from the walk: a corrected
transfer must not move the lot twice, and a retracted one never happened.

## Consequences

**Nothing is lost.** `asserted` keeps the original claim, and the raw record is
still in the log. The default read is correct and the audit trail survives.

**`/records/{id}/chain` deliberately does not derive custody.** That view answers
*what was claimed, and when*. Overwriting every historical version with the
current holder would erase the thing the caller came for.

**One query per page, not per lot.** `custodyTransfersFor` takes the whole page's
lot ids at once.

**Consent is decided on the asserted custodian, not the derived one.** The guard
runs before the walk. Whether custody transfer should also transfer read
entitlement is a consent question and belongs to D3, not here.

**A broken chain is surfaced, never resolved.** Two parties transferring the same
lot at once presents as `broken: true`, the same as a transfer from a party who
was not holding it. The kernel does not pick a winner — same principle as the
supersession fork in decision 0002.

## Rejected: flagging a broken chain at ingest

Attaching `custody_chain_broken` to the offending transfer would name the record
responsible, which is attractive. It was rejected because `quality_flags` are
written once and never updated, so the flag would depend on the order records
happened to sync — the same three records arriving in a different order would
produce different flags on the same log. An order-dependent immutable flag is a
worse artefact than no flag. `custody.broken` is computed from the whole chain
every time and is always correct.
