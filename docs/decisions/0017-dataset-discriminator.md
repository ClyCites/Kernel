# 0017 — Fabricated records are separated at the row, not by refusing to mix them

Status: accepted
Date: 2026-08-03
Supersedes: nothing
Relates to: 0001 (append-only), 0005 (record storage layout)

## Context

The adversarial seed writes roughly two hundred deliveries, forty parties, and a
deliberate spread of quality failures into a real kernel through the real public
API. None of it happened. All of it is permanent: decision 0001 removed DELETE
from the application role, and there is no route by which a row leaves the log.

Left undistinguished, those rows are indistinguishable from claims a farmer
actually made. Three consequences, in ascending order of seriousness:

1. `/metrics` reports `kernel_assumed_conversion_share` — the number an operator
   watches to decide whether the conversion registry can be trusted. Seed data
   is engineered to have a bad share. The gauge stops meaning anything.
2. Applications reading through the public API get invented farmers back, and
   the API has no way to say which is which.
3. Work order I anchors a daily Merkle root to a public ledger. Anchoring seed
   data publishes fabricated farmer records irreversibly. There is no correction
   for that; the root is signed and the ledger does not forget.

## Options considered

**(a) A seed generator that refuses to run against a database holding real
records.** Simplest, and no schema change. Rejected: three later work orders
assume long-lived environments holding both. E specifies staging as production
configuration "seeded with `dataset: 'seed'` data only" — a permanent
environment, not a scratch one. F puts `dataset` in every audit entry. I makes
the anchoring guard `dataset: 'live'` only. A refusal at generator start cannot
express any of that, and it fails open the moment somebody points the generator
at the wrong URL with an empty database that later becomes production. The dev
database already holds a legacy delivery from an earlier experiment, which is a
small demonstration that this happens.

**(b) A storage-layer discriminator on every row.** Chosen.

**(c) Separate databases.** Strongest isolation, and it defeats the purpose: the
seed exists to prove the real deployment behaves correctly, and a seed that runs
against a different database proves something about a different database. It
also doubles the operational surface — two backup schedules, two migration
states — for a property (b) gets from one column and a check constraint.

## Decision

`facts.record`, `inference.record` and `kernel.record_key` each carry
`dataset text not null default 'live'`, constrained to `('live','seed')`.

**It is not an envelope field and `@clycites/schema` is untouched.** The schema
describes what a record asserts about the world. Which corpus a row belongs to
is not a claim anybody is making — it is a fact about this deployment's
bookkeeping, and putting it in the envelope would both pollute the contract and
hand the client the pen.

### The write side

`IngestService.ingest(payload, context)` takes the dataset from the context,
never from the payload. The context is filled by the controller from the
`x-clycites-dataset` header, and the header is honoured **only** when
`SEED_INGEST_ENABLED` is true. It defaults to false, so a production instance
ignores the header however the request is dressed up.

`SEED_INGEST_ENABLED` is `z.enum(['true','false'])` rather than a coerced
boolean on purpose: `z.coerce.boolean()` treats every non-empty string as true,
which would turn a stray `SEED_INGEST_ENABLED=no` into a live seeding switch.

The header can only ever select `seed`. Nothing can mark a record `live` that
was not already going to be live — which matters less than the converse:
**nothing can mark a real record `seed`**, because that is the move that gets a
record quietly skipped by anchoring.

### The read side

`Reader.dataset` defaults to `'live'`, so every existing caller keeps seeing
exactly what it saw. A caller sees fabricated records only by asking for them in
as many words.

Crucially the separation is enforced *in the shared SQL fragments*, not at each
call site. `SUPERSEDED`, `RETRACTED` and `DERIVED` all now require
`s.dataset = r.dataset`. That means a fabricated retraction cannot hide a real
record and a fabricated correction cannot fork a real chain, and no query
written in future can forget the check, because the check is not in the query.
Every derived read — custody, mass balance, fulfilment, subject resolution,
settlement — takes the dataset as a parameter, so a live agreement can never
tally a seed delivery.

`tonnageByConversionBasis` is hardcoded to `'live'` with **no parameter to say
otherwise**. It feeds an operational gauge, and an operational gauge that can be
asked to include invented tonnage will eventually be asked.

Cross-corpus supersession and retraction are rejected with "record … is not in
the log" rather than a cross-corpus message. A distinguishable error would let a
caller with seed access enumerate live ids by watching which message came back.

## Consequences

- Anchoring (work order I) gets its guard for free: batch on `dataset = 'live'`.
- Audit (work order F) can record the corpus of every access as specified.
- Staging (work order E) can run production configuration against seed data.
- The seed generator can be run repeatedly against a long-lived environment.
- Three partial indexes on `dataset <> 'live'`. Partial because `live` is almost
  every row and an index on it would never be chosen; the selective direction is
  "show me the seed corpus", which the seed's own verification asks constantly.
- A future third corpus — a redaction quarantine, say — is one enum value and a
  constraint change, not a migration of every read path.

## What this does not do

It does not make seed data safe to look at. It is still personal-data-shaped
content sitting in the same tables under the same role grants, and a bug in the
dataset predicate discloses it. The guard is a correctness boundary, not a
security boundary. If seed data ever needs to be *unreachable* rather than
merely *not returned by default*, that is option (c) and a different decision.
