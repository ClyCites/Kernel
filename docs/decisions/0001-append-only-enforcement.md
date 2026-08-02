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

## Consequences

- Corrections are new rows with `supersedes` set (spec §8). There is no other
  mechanism, because no other mechanism is possible.
- Schema changes require the migrator connection, which is not the connection
  the application holds. Deploys run `pnpm migrate` as a separate step.
