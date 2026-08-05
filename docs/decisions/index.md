# Decisions

Forty architecture decision records. Each one exists because a choice was made
that looks arbitrary from the outside, and the reasoning would otherwise be lost
the moment the person who made it stopped being reachable.

These are the authority. Where a page elsewhere in this site summarises one, the
ADR wins.

!!! note

    The work order that commissioned this site said thirty-eight. There are
    forty: `0039` (schema v0.3) and `0040` (MinIO) landed after it was written.
    `0040` supersedes the object-store choice in `0037`; `0029` supersedes the
    consent stub in `0009`.

---

## Storage and the append-only invariant

| | | |
|---|---|---|
| [0001](0001-append-only-enforcement.md) | Append-only is enforced by the database role | Not by application code, because application code can be bypassed and a grant cannot |
| [0002](0002-derived-fields.md) | `superseded_by` and `stale` are derived, not stored | A stored derived field requires an `UPDATE`, which the role forbids |
| [0005](0005-record-storage-layout.md) | Record storage layout | One table per namespace, partitioned monthly, payload as JSONB |
| [0022](0022-lineage.md) | Lineage: staleness, cycles, and who may correct | Who is entitled to supersede, and what happens when a chain loops |

## Ingest

| | | |
|---|---|---|
| [0006](0006-idempotency-and-id-conflict.md) | Idempotency is on the id, and a reused id is refused | Retry safety without silently accepting a different record under an old id |
| [0007](0007-delegation-resolution.md) | Delegation is resolved at ingest, and forks refuse authority | Authority is checked against the moment of the event, not the moment of the write |
| [0015](0015-subject-ref-integrity.md) | `Observation.subject_ref` is checked, not enforced | A foreign key would make the referenced record undeletable and the reference untyped |
| [0019](0019-lawful-basis.md) | Every record states the ground it was collected under | s.7, made structural rather than procedural |

## Quantity, conversion and quality

| | | |
|---|---|---|
| [0011](0011-losses-as-observations.md) | A declared loss is an Observation, not a field | A loss is somebody's assertion at a time, with its own provenance |
| [0014](0014-mass-balance.md) | Mass balance is reconciled across the custody sequence | Flag the discrepancy; never reject the record that revealed it |
| [0018](0018-conversion-provenance.md) | A measured conversion has to show what it measured | Sample size and method, or the factor is an assumption wearing a number |

## Custody, fulfilment and settlement

| | | |
|---|---|---|
| [0012](0012-derived-custody.md) | `Lot.custodian` is computed from the transfer chain | A stored custodian and a transfer chain will eventually disagree |
| [0013](0013-fulfilment-on-read.md) | Fulfilment is summed on read, never stored | Same reason; the sum is a view of the deliveries, not a fact beside them |
| [0016](0016-settlement-summary.md) | Settlements are summarised per obligation, and never per party | A per-party balance is a wallet, and a wallet makes this a financial institution |
| [0021](0021-fork-semantics-in-derived-views.md) | A forked record is counted in nothing | Ambiguous provenance must not silently contribute to a total |

## Datasets and the inference quarantine

| | | |
|---|---|---|
| [0017](0017-dataset-discriminator.md) | Fabricated records are separated at the row, not by refusing to mix them | Separate databases drift; a row-level discriminator cannot be forgotten |
| [0023](0023-adversarial-seed.md) | The adversarial seed | Seed data that contains the problems, so the flags are exercised before real data arrives |
| [0036](0036-p4-inference.md) | P4: the inference module closed | Fetch by name, no listing, no application write path |

## Registry and reference data

| | | |
|---|---|---|
| [0010](0010-registry-storage.md) | Reference data lives in its own append-only schema | A conversion factor that changes retroactively changes history |
| [0024](0024-registry-read-api.md) | The registry is public, and the sample is stored | The only unauthenticated read surface, and the one that must be auditable |
| [0027](0027-season-calendar.md) | The season calendar is a registry table, not a schema change | Defers D5 |
| [0028](0028-registry-ceiling.md) | A ceiling on the observation vocabulary | Defers D8; an unbounded vocabulary is an unbounded schema |

## Sync and devices

| | | |
|---|---|---|
| [0008](0008-sync.md) | Sync is two endpoints and no server-held state | Server-held per-device state is the part of sync that breaks |

## Identity and parties

| | | |
|---|---|---|
| [0026](0026-party-links.md) | Party links: `same_as` as a reversible assertion | Defers D2; merging identities is irreversible and often wrong |

## Consent, rights and disclosure

| | | |
|---|---|---|
| [0009](0009-consent-stub.md) | A consent stub that fails closed | Superseded by 0029, but the fail-closed default survives |
| [0025](0025-audit-log.md) | The audit log is a statutory record | s.36 and s.37, not a debugging convenience |
| [0029](0029-consent.md) | Consent | Grantee, purpose, record types, expiry — all five, always |
| [0030](0030-objection.md) | Objection under s.7(3) | And why it is not withdrawal |
| [0031](0031-subject-access.md) | Subject access under s.24 | Including why the route takes no subject parameter |
| [0032](0032-disclosure-notification.md) | Notifying the parties who received the old version | s.16(4) |
| [0035](0035-p3-retention-and-naming.md) | J5 retention notice, J6 naming discipline | s.13(1)(i), and the words this system refuses to use |

## Lender-facing output

| | | |
|---|---|---|
| [0034](0034-p2-lender-view.md) | The lender view is read as the lender | Rendered by the kernel, because a rule in one renderer can be reviewed |

## Media, anchoring and integrity

| | | |
|---|---|---|
| [0037](0037-p5-media.md) | Media: bytes that survive a bad link and disclose nothing | Object-store choice superseded by 0040 |
| [0038](0038-p6-anchoring.md) | P6: anchoring | The mechanism, and why verification must be external |
| [0040](0040-minio.md) | MinIO, reversing 0037 | Including the anonymous-policy requirement nothing yet tests |

## Toolchain and operations

| | | |
|---|---|---|
| [0003](0003-toolchain.md) | TypeScript 7 for compilation, TypeScript 6 for the linter | Two versions, deliberately, until the linter catches up |
| [0004](0004-postgis-image.md) | PostGIS image for local development | Parity with production over convenience |
| [0020](0020-operational-baseline.md) | Verified backups, config guards, statutory runbook | The minimum before real data could be accepted |

## Retrospectives

| | | |
|---|---|---|
| [0033](0033-p1-fixes.md) | The six fixes: what they were, and what two of them turned out to be | Two were not bugs; the record of that is more useful than the fixes |
| [0039](0039-schema-v0.3.md) | Schema v0.3 | Including §7 on two-sided confirmation |
