# Backup and restore

**The failure mode this is built against: a restore that verifies 1,261 manifest
lines perfectly and resolves no photographs.**

That is worse than a restore that fails, because it reports success. An untested
backup is a belief, not a backup — so `test/ops/` runs both scripts for real,
inside a container, on every CI run.

## Taking one

The object inventory is its own step, because there is no single environment
that can do the whole job:

```bash
scripts/backup-objects.sh /path/objects.txt          # needs the Node toolchain
BACKUP_PASSPHRASE=… BACKUP_OBJECTS_FILE=/path/objects.txt \
  scripts/backup.sh                                  # needs pg_dump, psql, openssl
```

`backup.sh` needs `pg_dump`, `psql` and `openssl` in one place; the object
inventory needs Node. The database container has the first three and no Node; a
developer laptop typically has Node and none of the first three. Rather than
narrating that as a limitation, the inventory is a separate step whose output is
handed to the backup.

If you have no object store at all, you must **say so**:

```bash
BACKUP_NO_OBJECT_STORE=true scripts/backup.sh
```

## A backup cannot skip objects and succeed

| Situation | Result |
|---|---|
| Object store configured and reachable | Inventory recorded, `object_inventory present N` |
| Object store configured, unreachable | **fail** |
| No object store, and `BACKUP_NO_OBJECT_STORE=true` | `object_inventory declared-absent 0` |
| No object store, no declaration | **fail** |
| No Node toolchain for the inventory step | exit 2, with the command to run elsewhere |

This used to print `objects NOT backed up` and exit 0. In production that
produces exactly the failure described at the top of this page.

## What the manifest holds

- row counts per table
- primary-key fingerprints
- **every constraint with its validated flag**
- **every table grant**
- the object inventory line

The grants and constraints are there because append-only leaves no
reconciliation path. If a restore silently dropped a `CHECK` or handed
`kernel_app` an `UPDATE`, nothing downstream would notice until it mattered, and
by then there would be no way to tell which rows were affected.

## Restoring

```bash
BACKUP_PASSPHRASE=… scripts/restore.sh backups/<stamp> <url>
```

It checks the archive against its checksums, decrypts, restores, regenerates the
manifest, and diffs. **Exit 0 requires an exact match.**

It refuses any target database not named `restore`, `test` or `scratch`. A
restore script that can be pointed at production is a loaded weapon in a
procedure people run under stress.

### Exit 3

```text
restore: database verified; OBJECTS NOT VERIFIED (deferred)
         run: apps/kernel tsx src/media/inventory-cli.ts verify
```

Set `RESTORE_OBJECTS_DEFERRED=true` when the object half has to run elsewhere.
The database is verified and the objects are not — neither success nor failure,
so exit 3, the same distinction the anchoring CLI draws for a root computed but
unpublished.

A manifest with **no** object section at all is an incomplete manifest, and
`restore.sh` refuses to verify against it.

## What the verification does not cover

Runbook §2 has the full list. The short version: it proves the bytes came back
and the structure matches. It does not prove the data was correct when it was
taken.

## Proving media survives

The dry run finishes the restore by resolving an actual `MediaRef`:

```text
  objects: 1 named by the database, 1 in the bucket
  objects: verified — every named object is present
  the evidence photograph still resolves after restore: 98336 bytes
```

Row counts matching is not the same as a photograph resolving, and the second is
the thing a dispute will turn on.

## Where backups live

`backups/` is git-ignored, and retained off-host. See Runbook §2 for retention
and §3 for rotating `BACKUP_PASSPHRASE`.

## Recovery objectives

In Runbook §2. They are stated targets, not measured ones — no timed restore
drill has been run against a production-sized dataset, because there is no
production dataset.
