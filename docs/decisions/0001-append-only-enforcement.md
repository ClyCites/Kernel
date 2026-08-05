# 0001 — Append-only is enforced by the database role

**Status:** accepted
**Date:** 2026-08-02

## Context

Brief §4 invariant 1: there is no UPDATE and no DELETE, and the rule must be
enforced at the database role level rather than by convention in application
code. Spec §1 P2 and §8 say the same thing from the data-model side.

An application-level rule is a rule until someone writes a repository method
that seems reasonable in isolation. A missing grant is not negotiable.

## Decision

Two roles:

| Role | Rights | Used by |
|------|--------|---------|
| `clycites_owner` (migrator) | owns the schemas, all DDL | `pnpm migrate` only |
| `kernel_app` | `INSERT`, `SELECT` on `facts.record`, `inference.record`, `kernel.record_key` | the running kernel |

`kernel_app` is created `nosuperuser nocreatedb nocreaterole noinherit`, has no
`CREATE` on any schema, and `UPDATE`/`DELETE`/`TRUNCATE` are explicitly revoked
in `0006_grants.sql` even though Postgres grants none of them by default —
because that file is where an auditor looks for the answer.

The password for `kernel_app` is supplied to migration `0001_roles.sql` as a
transaction-local setting (`kernel.app_password`) rather than being written into
a `.sql` file.

## Verification

`apps/kernel/test/invariants/storage.test.ts` asserts, against a real Postgres:

- `UPDATE`, `DELETE`, `TRUNCATE`, and `CREATE TABLE` from `kernel_app` all fail
  with SQLSTATE `42501` (insufficient privilege), in both namespaces
- the grants visible in `information_schema.role_table_grants` for `kernel_app`
  are exactly `{INSERT, SELECT}`

If someone adds an `UPDATE` grant, that last test fails.

## Limitation: this binds `kernel_app`, not the database

Stated plainly because the overclaim is worse than the gap.

**Append-only is a property of the application role. It is not a property of the
database.** `clycites_owner` owns the schemas and retains `DELETE` on every
record table. At the Postgres level this cannot be durably fixed: a table owner
can re-grant to themselves at will, so any revocation against the owner is
advisory. There is no arrangement of grants that makes a Postgres table
immutable to the role that owns it.

We use this ourselves, legitimately — clearing a stale seed corpus so it can be
regenerated is an owner `DELETE`. So the honest claim is not "records cannot be
deleted". It is:

> Nothing the running kernel can do will remove or alter a record. Removing one
> requires migrator credentials, and is designed to be visible and eventually
> provable.

Anyone reviewing this system technically will establish the owner's rights in
about ten minutes. Once one claim is found overstated, every other claim gets
discounted — including the ones that are exactly true.

### The layered model

No single layer is sufficient. The defence is real anyway, because the layers
fail in different directions:

| Layer | Catches | Does not catch |
|---|---|---|
| Grants (this decision) | The application, in all normal operation | Anyone holding owner credentials |
| Audit (0025) | Makes owner action **visible** — DDL and deletions land in a log the app cannot read or edit | Someone who can also reach and rewrite the audit log |
| Anchoring (work order I) | Makes deletion **provable** — a record whose hash sits in a published Merkle root cannot go missing quietly | Nothing, for records already anchored |

Anchoring is the layer that actually closes this, and it closes it by moving the
evidence outside our control entirely. That is the intended end state: until a
record is anchored, its permanence rests on our operational discipline; after it
is anchored, it rests on a published root we cannot retract. Everything before
that layer is defence in depth, not proof.

**No record is anchored today.** Roots are computed and stored; none has been
published, so the row above describes a layer that is built and not yet
operating. Read it as the end state, not as the current one — every record in
this system rests on operational discipline until that changes. See 0038.

### What is enforced at the database today

Migration `0016_no_live_deletion.sql` adds a `before delete` trigger to
`facts.record`, `inference.record` and `kernel.record_key` that permits
`dataset = 'seed'` and raises on `dataset = 'live'`, for **every** role
including the owner.

This preserves the one legitimate use of owner `DELETE` and blocks the
realistic threat, which is not a malicious operator but a tired one running a
cleanup statement without a `where` clause at the wrong time.

A determined owner can drop the trigger. That is true and is written in the
migration rather than glossed. But dropping it is a DDL event, and 0025 captures
DDL events — so the trigger converts silent data loss into an act that leaves a
mark. Accidents are the realistic threat and this stops those outright.

## Consequences

- Corrections are new rows with `supersedes` set (spec §8). There is no other
  mechanism, because no other mechanism is possible.
- Schema changes require the migrator connection, which is not the connection
  the application holds. Deploys run `pnpm migrate` as a separate step.
- Clearing the seed corpus is a supported owner operation. Clearing live records
  is refused by the database and would require dropping a trigger to attempt.
- Marketing and security copy must say "the application cannot alter records",
  never "records cannot be altered", until anchoring ships.
