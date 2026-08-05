# Migrations

Numbered, forward-only SQL. Thirty-two of them, `0001_roles.sql` through
`0032_objection_effect.sql`.

```bash
pnpm migrate
```

```text
applied 32, already applied 0, partitions ensured 52
```

The migrator applies pending migrations and provisions monthly partitions ahead
of time. Partition provisioning is idempotent and runs on every invocation, so a
deploy that happens to cross a month boundary does not fail on a missing
partition.

## There are no down migrations

Not "we have not written them" — the shape of the system forbids them.

A down migration on an append-only store either drops data that cannot be
recovered or leaves the schema in a state that does not match any version.
Neither is a rollback. Runbook §4 has the real procedure: forward-fix, or
restore from a verified backup.

## What the migrations establish

The first four are the ones worth reading, because they are where the invariants
live rather than being described:

| | |
|---|---|
| `0001_roles.sql` | `clycites_owner` and `kernel_app`, and the grants that make append-only real |
| `0002_schemas.sql` | `facts`, `inference`, `kernel`, `audit` — the quarantine as a namespace boundary |
| `0003_record_tables.sql` | The record tables and the constraints |
| `0004_partitions.sql` | Monthly partitioning by date |

The grant is the point:

```text
facts.record           INSERT, SELECT
inference.record       INSERT, SELECT
kernel.record_key      INSERT, SELECT
```

No `UPDATE`, no `DELETE`, no exception for the owner's own rows.

## Writing one

- Forward only. Never edit an applied migration; add another.
- If a change would need an `UPDATE` on a record table, the design is wrong, not
  the permission.
- A migration that adds a column recording something a data subject was told
  should make that column unwritable afterwards. The objection `effect` column
  is the worked example: the first implementation tried to fill it with an
  `UPDATE` and the role refused, which was the database catching a design error
  that review had not.
- New record types need no migration. The database does not enumerate them, and
  partitions are by date.

## Constraints that are `NOT VALID`

`facts_lawful_basis_stated` and `inference_lawful_basis_stated` are declared
`NOT VALID`: enforced for new rows, not verified against existing ones.

They were added after rows existed that could not comply. Validating them
requires either correcting those rows — which append-only does not permit — or
superseding them, which is a data exercise rather than a migration.

The backup manifest records **every constraint with its validated flag**, so
this cannot quietly become permanent without showing up in a restore diff. It is
listed on [What is not yet true](../compliance/not-yet-true.md).

## The SI conversion rows

`0031_si_conversions_corrected.sql` corrected a set of SI conversion factors.
Those rows should carry basis `definitional` — a kilogram is a thousand grams by
definition, not by measurement — but that enum value does not exist until schema
v0.3 lands in the registry constraint.

So the supersession is deliberately **not** chained yet, and
`unit_conversion_basis_check` has not been widened. Chaining it now would mean
superseding rows into a basis the constraint rejects.
