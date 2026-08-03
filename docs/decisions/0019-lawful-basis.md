# 0019 — Every record states the ground it was collected under

Status: accepted
Date: 2026-08-03
Supersedes: nothing
Relates to: 0001 (append-only), 0017 (dataset), 0006 (rejection vs flagging)

## Context

Data Protection and Privacy Act, 2019 (Act 9 of 2019), s.7(3): where a data
subject objects, processing must stop — "except for data collected or processed
under subsection (2)".

That exception clause is the whole decision. Whether a farmer can stop us
processing a given record depends on the ground relied on **when that record was
collected**. Not on what we would claim afterwards, not on an organisation-wide
policy setting, and not on the record's type. Two deliveries of identical shape
can resolve differently under the same objection if they were collected under
different grounds.

So the basis is a per-record fact, and it is a fact about the past.

This log is append-only. Decision 0001 removed DELETE and UPDATE from the
application role. A record ingested without a basis can never acquire one, and
an objection against it can never be answered correctly — not "answered with
difficulty", but never, because the information that would answer it was never
captured and cannot be reconstructed.

That is why this lands before the adversarial seed, for the same reason `dataset`
did.

## Decision

A `lawful_basis` column on `facts.record` and `inference.record`, carrying one
of nine values:

| Value | Section |
| --- | --- |
| `consent` | s.7(1) |
| `legal_authorisation` | s.7(2)(a) |
| `public_duty` | s.7(2)(b)(i) |
| `national_security` | s.7(2)(b)(ii) |
| `law_enforcement` | s.7(2)(b)(iii) |
| `contract_performance` | s.7(2)(c) |
| `medical` | s.7(2)(d) |
| `legal_obligation` | s.7(2)(e) |
| `special_data_consent` | s.9(3)(b) |

The value is declared by the caller in the `x-clycites-lawful-basis` header, not
carried in the record body. Ingest rejects a write that does not declare one.

## Why the header and not the body

The basis is a fact about the collection, not about the event. A delivery
happened at a weighbridge on a Tuesday; the ground on which we are entitled to
hold the account of it is a property of our relationship with the farmer. Those
are different things and conflating them would let a client assert a basis as
part of the payload it is describing.

It also keeps the wire document unchanged. `toDocument()` enumerates fields
explicitly, so neither `dataset` nor `lawful_basis` leaks into the document that
gets hashed and, later, anchored.

## Why the storage layer and not `@clycites/schema`

`@clycites/schema` is vendored read-only. This is a candidate for promotion to
the envelope in schema v0.3, once counsel confirms the enum. Until then it lives
where `dataset` lives, for the same reason.

## Why NOT VALID rather than a backfill

```sql
alter table facts.record
  add constraint facts_lawful_basis_stated check (lawful_basis is not null)
  not valid;
```

`ADD COLUMN ... NOT NULL` requires a default, and there is no honest default.
Writing `'consent'` across the existing rows would assert a consent nobody
obtained — which is the precise failure this column exists to prevent — and
append-only means that lie could never be corrected.

`NOT VALID` enforces on every subsequent INSERT and UPDATE while leaving
pre-0013 rows unexamined. It is enforced against the schema owner too, not only
the application role; `test/records/lawful-basis.test.ts` asserts both that
(`not even the schema owner can write a record without a basis`) and that the
constraint is genuinely unvalidated rather than silently passing
(`records written before 0013 are grandfathered, not backfilled`, which reads
`pg_constraint.convalidated`).

Those pre-0013 rows report as `unstated` in the census. They are visible, they
are counted, and they are not lied about.

## Why rejecting, despite P6

P6 says flag, never reject. It is the strongest principle in the spec and this
departs from it deliberately.

P6 exists so that a farmer's account of what happened is never discarded because
it was inconvenient or badly formed. A missing lawful basis is not a defect in
the farmer's account. It is a defect in **our authority to hold it**. Storing it
flagged would be doing the unlawful thing with a note attached — the note does
not make the holding lawful, and append-only means we could not undo it once we
noticed.

The rejection is a `403`, not a `422`. The record is well formed; what is
missing is the caller's standing, not the payload.

## Financial records are s.9 special data

`s.9(1)` lists financial data among the special categories. `s.9(3)(b)` permits
processing it with consent.

A record is treated as financial if its type is `obligation` or
`settlement_reference`, or if it is a `delivery` carrying `agreed_price`. For
those, `special_data_consent` is the only accepted basis. Every other value is
rejected with `lawful_basis_insufficient`.

Non-financial types accept all nine. This is deliberately permissive: which of
the s.7(2) grounds a given record type could honestly rest on is a question for
counsel, and hardcoding an answer here would encode an interpretation that the
work order explicitly says to avoid. The kernel enforces what is true under any
reading — that a basis must be stated, and that special data needs s.9 consent —
and leaves the rest open.

## FINDING: almost every Delivery is special data

`deliveryDocument`, which mirrors Appendix A of the core-facts spec, carries
`agreed_price`. If the real corpus looks like the spec's own example, the
platform runs almost entirely on s.9(3)(b) consent.

That is the basis a farmer **can** withdraw under s.7(3) — it is not one of the
s.7(2) exceptions. So the objection machinery in J2 will, in practice, stop
processing on nearly the whole delivery corpus rather than on a narrow slice.

Two things follow, neither of which this decision settles:

1. If deliveries do not need to carry `agreed_price` for the lender metrics to
   work, omitting it moves them out of s.9 entirely and materially reduces
   exposure. That is a product question.
2. If they do need it, the consent obtained at enrolment must be s.9-grade and
   evidenced, which is what J5's retention notice record is for.

Held by the test `FINDING: the default delivery is special data`. This is a
finding, not a fix.

## Objection resolution

`objectionStops(basis)` returns true for `consent` and `special_data_consent`,
false for the seven s.7(2) grounds. It is the predicate J2 will use, and it
exists now so that the seed's records are written against a resolution rule that
already has tests.

## Metrics

`/metrics` gains:

- `kernel_records_by_lawful_basis{basis,financial}` — the census, including
  `basis="unstated"` for grandfathered rows.
- `kernel_financial_records_without_special_consent` — financial records on any
  basis other than `special_data_consent`. Should be zero for everything written
  after 0013; a non-zero value means either a pre-0013 row or a gap in the
  allow-list.

## Test fixtures

`ingestServiceFor` in `test/helpers/fixtures.ts` defaults to
`lawfulBasis: 'special_data_consent'`. **Production has no such default and must
not have one** — the default exists only so that a hundred tests restating the
same basis do not obscure the handful that are actually about it. Tests that are
about the basis pass it explicitly.

## Consequences

- Every POST through the HTTP layer must send `x-clycites-lawful-basis` or get a
  403. This includes the adversarial seed generator, which now sends both that
  header and `x-clycites-dataset`.
- `SyncService.drain` carries an `IngestContext` through to each entry, so an
  offline batch declares its basis once for the batch.
- The expiry mechanism required by s.18(4) is **not** built. The retention
  period comes from the 2021 Regulations and is an open question with counsel.
  J5 records the notice given; the destruction job is a documented gap.
