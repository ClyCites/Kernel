# 0005 — Record storage layout

**Status:** accepted
**Date:** 2026-08-02

## Partition key

Both record tables are partitioned monthly by `recorded_at`, as the brief
requires. `recorded_at` rather than `occurred_at` because it is kernel-assigned
and monotonic: a device offline for three weeks appends records with old
`occurred_at` values, and partitioning on that would keep writing into cold
partitions. Offline-first ingest (brief §4 invariant 5) makes late `occurred_at`
the normal case, not the exception.

Provisioning is `kernel.ensure_record_partitions(behind, ahead)`, which is
idempotent and runs on every `pnpm migrate`. There is no scheduler, because §3
allows no queue and no cron. A DEFAULT partition on each table means an insert
outside every provisioned range is stored rather than refused — refusing a
record for an operational reason would violate P6.

**Operational note:** rows in a DEFAULT partition block later creation of a
partition covering their range. A non-zero count in `facts.record_default` means
provisioning has fallen behind and those rows must be relocated before the
missing month can be created.

## The id registry

Ingest is idempotent on the client-generated record id. A partitioned table
cannot carry a unique constraint on `id` alone — Postgres requires the partition
key in every unique index — so `unique (id, recorded_at)` would not stop a
replay landing twice with two different `recorded_at` values.

Uniqueness therefore lives in `kernel.record_key`, one unpartitioned table with
`id` as the primary key. Ingest does `insert ... on conflict (id) do nothing`;
no row returned means replay, and the original is returned instead. This is
atomic, rather than a check-then-insert race resolved by an advisory lock.

The registry spans both namespaces so that an id identifies exactly one record
anywhere in the kernel. It is never a read path: reads go to `facts.record`, so
the registry cannot leak an inference into a fact query.

## Envelope as columns, body as `jsonb`

The envelope is queried, indexed and constrained by the kernel, so it is real
columns. The entity body is `jsonb` because the kernel deliberately does not
know what is inside it — `@clycites/schema` does, and it is the only thing
permitted to validate it (brief §7: no second validation layer). `ext` is a
separate `jsonb` column, stored and returned verbatim, never read (spec §11).

## Quality flags live outside the body

Brief §4 invariant 4 requires records to be flagged, not rejected. The envelope
has no record-level `quality_flags` field, and `Quantity.quality_flags` is part
of the record the client submitted.

Kernel-derived flags are stored in a separate `quality_flags text[]` column and
returned alongside the record, never merged into it. Writing kernel-computed
values into a client's record would mean the bytes read back are not the bytes
asserted — the kernel would be quietly editing a claim, which is the thing the
whole design exists to prevent. It would also break exact round-tripping through
the Zod schema.

## Database-level constraints are not a second validation layer

`facts.record` carries check constraints for `record_class`,
`on_behalf_of`-requires-`delegation`, self-supersession, and
`occurred_at_precision`. These are the structural invariants of brief §4, not
business rules: Zod rejects these payloads first, and the constraints exist so
that no future code path — a migration, a bulk import, a repository written in
haste — can put the log into a state the invariants forbid.

No business rule is enforced in the database. Outliers, failed mass balance and
missing conversions are flagged at ingest and stored (spec §9.1).
