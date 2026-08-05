# The record model

**What it prevents: a database whose history you cannot reconstruct, and whose
figures you cannot attribute to anyone.**

The usual shape for this domain is a `deliveries` table with a `weight_kg`
column that gets updated when somebody notices it is wrong. That design loses
two things permanently the first time it is used: what the figure was before,
and who said so. A lender auditing a dispute six months later has one number and
no way to tell whether it has always been that number.

## A record is an assertion, not a row

Every record says: *this party asserts that this happened, at this time, to this
precision, on this legal ground.* It is not a statement of fact about the world.
It is a statement that somebody made a claim, and the kernel's job is to keep
that claim exactly as it was made, attached to whoever made it.

That framing decides most of the rest. If a record is an assertion, then:

- it cannot be edited, because an edited assertion is a different assertion;
- it must name an asserter, always;
- two assertions that disagree are both kept, because that disagreement is
  information;
- the kernel cannot reject a claim for being implausible, because implausible
  claims are made and someone needs to know they were.

## The envelope

Every record of every type carries the same envelope. The full list is on the
[Schema reference](../reference/schema.md); the fields that carry the weight
are:

| Field | Why it exists |
|---|---|
| `asserted_by` | Who is making this claim. Never optional. |
| `on_behalf_of` + `delegation` | Acting for somebody else, and the mandate that permits it. Neither is valid alone. |
| `occurred_at` + `occurred_at_precision` | When it happened, and how precisely that is known. A harvest is a day, a confirmation is an instant, a season is a season. |
| `recorded_at` | When it reached the log, which is usually much later. |
| `lawful_basis` | The ground under which it was collected. |
| `supersedes` | The record this one corrects. |
| `record_class` | `observation` or `inference`. A pinned literal, not a flag. |

`occurred_at_precision` has no default. A default would manufacture precision,
and manufactured precision poisons every analytic downstream of it — a
"2026-07-18" that actually meant "sometime that week" is indistinguishable from
one that meant that day, once it is stored.

## Flag, never reject

The kernel stores what it was told and records what is wrong with it. An
implausible weight, a delivery to oneself, a lot whose components do not add up,
a quantity nobody normalised — all stored, all flagged.

The reason is not leniency. A record refused at the door does not stop existing;
it exists in a notebook, or in the head of the officer who was turned away, and
now nobody can see it. A flagged record in the log is visible, countable, and
fixable. A rejected one is invisible and permanent.

Only **structurally impossible** records are refused: a record that supersedes
itself, a record whose id is already taken by a different record, a delegation
that was not live when the event happened, a confirmation by somebody who was
not party to the delivery. In each case there is nothing coherent to store.

The flags a record can carry, and the words used for each, are on the
[Quality flags reference](../reference/quality-flags.md). The renderer refuses
to show a flag with no glossary entry, so the vocabulary cannot quietly grow.

## Seventeen record types

`party`, `account`, `delegation`, `membership`, `facility`, `plot`, `planting`,
`harvest`, `observation`, `lot`, `custody_transfer`, `delivery`,
`delivery_confirmation`, `agreement`, `obligation`, `settlement_reference`,
`retraction`.

They share one write path and one read path. The envelope is identical across
them, so ingest, provenance, supersession and idempotency are entity-agnostic —
the only per-entity code in the kernel is two lookup tables, not branches in the
pipeline.

Some deliberate absences:

- **No `wallet`, `balance` or `ledger`.** The kernel is non-custodial and a test
  asserts those names do not exist.
- **No `loss` entity.** A declared loss is an `observation`, because it is
  something somebody claims rather than a state of the world
  ([0011](../decisions/index.md)).
- **`Lot.custodian` is not a field.** It is computed from the transfer chain
  ([0012](../decisions/index.md)).

## What is derived, never stored

`superseded_by`, `stale`, `Lot.custodian`, fulfilment totals, and the
confirmation status of a delivery are all computed on read.

A stored derived field is a second source of truth that can disagree with the
first. Worse, in an append-only store there is no `UPDATE` available to
reconcile it — so the wrong value would be permanent. See
[0002](../decisions/index.md) and [0013](../decisions/index.md).

The `delivery_confirmation` record is the newest instance of this pattern and
the clearest: a delivery has no confirmation field at all, and its confirmation
status is derived from records the counterparty asserted.
[Two-sided confirmation](../flows/confirmation.md) explains why that is not a
refactor but the load-bearing change in the credit thesis.
