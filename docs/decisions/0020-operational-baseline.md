# 0020 — Operational baseline: verified backups, config guards, statutory runbook

Status: accepted
Date: 2026-08-03
Work order: E
Relates to: 0001 (append-only), 0017 (dataset), 0019 (lawful basis)

## Context

The kernel had 300 passing tests and no way to survive losing its database. It
also had no written procedure for a data breach, which the DPPA requires be
notified to the Authority *immediately* — not within a fixed window.

Two properties of this system make the ordinary answers insufficient.

**Append-only means a restore must be verified, not merely attempted.** There is
no reconciliation path afterwards. If a restore silently loses rows or drops a
constraint, the invariant is gone and nothing reports it, because every test in
the suite exercises a database that already has the constraint.

**Most self-hosted incidents are configuration mistakes, not attackers.** A
published Postgres port or a copied `.env` with `SEED_INGEST_ENABLED=true` is
invisible to every functional test.

## Decision

### 1. Backups carry a manifest, and the manifest is the deliverable

`scripts/backup.sh` writes an encrypted `pg_dump` **and** a manifest recording,
per table: row count, an md5 fingerprint over ids in deterministic order, and
the full set of constraint names per schema.

`scripts/restore.sh` regenerates the same manifest from the restored database
and diffs. Exit 0 only on an exact match.

Three consequences worth stating:

- **Constraint names are compared.** This is the most important of the three. A
  dropped CHECK is worse than a failed restore. The kernel's correctness rests on
  constraints — append-only grants, the `record_class` pin, 0012's measured-basis
  sample requirement, 0019's `lawful_basis` requirement — and a database missing
  one still starts and still serves traffic.
- **Fingerprints are over ids, never whole rows.** jsonb key ordering is not
  stable across server versions; row-level hashing would produce a false mismatch
  on every Postgres upgrade and the check would be switched off within a month.
- **The manifest query is duplicated verbatim in both scripts rather than
  shared.** If the two ever drift, the verification is worthless — and a shared
  helper would let them drift while still agreeing with each other. Duplication
  is the safer failure mode here.

`restore.sh` refuses any target database whose name lacks `restore`, `test`, or
`scratch`, because it drops and recreates the target.

Two additions the implementation made to the above. The manifest also records
**table grants**, because append-only is enforced by `kernel_app` not holding
UPDATE or DELETE, and a grant is not a constraint. And each constraint line
carries its **validated flag**, because `facts_lawful_basis_stated` and
`unit_conversion_measured_shows_sample` are both `NOT VALID` on purpose; a
restore that quietly validated them would be a different database.

`test/ops/restore.test.ts` runs the real scripts inside the Postgres container
rather than on the host. `pg_dump` refuses to dump a server newer than itself,
so running them where the server lives is the only way to guarantee the client
and server majors match — and it means the test needs nothing installed beyond
Docker. Three of its cases tamper with the manifest and assert the verification
*fails*, because a comparison that cannot report a mismatch is indistinguishable
from no comparison at all, and that is the state a verification script drifts
into.

### 2. Configuration is asserted, not documented

`test/ops/exposure.test.ts` fails if:

- a data-tier service publishes a port
- anything binds `0.0.0.0` explicitly
- `.env.example` omits a required variable
- `.env.example` ships `SEED_INGEST_ENABLED=true`
- no startup guard exists refusing production with seed ingest enabled
- any route resembles a bulk export

On the first of those the implementation settled on loopback rather than nothing
at all: `docker-compose.yml` now publishes `127.0.0.1:5433:5432`, and the test
requires every data-tier port to carry an explicit loopback address. A bare
`5433:5432` publishes on every interface the host has, which on most VPS images
is the open internet. Refusing to publish anything would have made local
development impossible and the rule would have been deleted rather than
followed.

The last one deserves note. **We currently owe no s.16(4)
disclosure-notification machinery because there is no export path** — with
view-only access, revoking access is sufficient; with exports, a lender becomes
an independent holder and we owe a notification for every future correction,
indefinitely. "Never add an export" decays as a memory and holds as a failing
build.

### 3. Secret scanning is narrow on purpose

`scripts/check-secrets.sh` matches real credential formats and secret-shaped
assignments with real-looking values, and allowlists placeholders so
`.env.example` and docs stay useful.

A scanner that fires on every base64 string gets disabled within a week, and a
disabled scanner is worse than none because it remains in CI implying coverage.

It runs in CI over everything git tracks, and as a `pre-commit` hook over what
is staged. The hook lives in `.githooks/` under version control rather than in
whoever's `.git` directory happened to run the installer; `scripts/install-hooks.sh`
points `core.hooksPath` at it.

### 4. The runbook encodes statutory timing

`docs/runbook.md` §1 is the s.23 breach procedure. Three points are non-obvious
and easy to get wrong under pressure:

- Notify on **belief**, not proof, and immediately — containment does not wait
  for notification and notification does not wait for containment.
- **Do not delete anything.** s.36 makes unlawful destruction of personal data a
  criminal offence, and the append-only log is the evidence.
- **The Authority decides whether data subjects are notified** (s.23(2)), not us.
  Prepare the text; do not send it unilaterally.

§6 is a monthly verification table with a dated log, because s.20(2) requires
*regularly verifying* that safeguards are effectively implemented. A one-off
hardening pass does not satisfy it, and under s.33(2) the dated log forms part of
a reasonable-care defence.

## Alternatives considered

**Managed backups from the host provider.** Rejected as the only mechanism: it
produces no manifest, verifies nothing, and leaves us unable to demonstrate a
tested restore. Worth having in addition.

**A generic secret scanner (gitleaks, trufflehog).** Reasonable and worth adding
to CI later. Not sufficient alone: none of them knows that
`SEED_INGEST_ENABLED=true` in a production environment is a data-integrity
incident.

**Down-migrations for rollback.** Rejected, consistent with the append-only
design. Rollback is a forward migration, and anything that would need to change
record data is an incident rather than a deployment.

## Consequences

- A restore can be demonstrated, not asserted. This is also the first thing a
  bank or government due-diligence review asks for.
- Adding an export endpoint now requires deleting a test and explaining why,
  which is the intent.
- The runbook has empty contact rows. **That is a real gap, not a template
  placeholder** — fill it before it is needed.
- Restore verification currently trusts a manifest we wrote ourselves. Once
  anchoring ships (work order I), completeness can be verified against published
  Merkle roots instead, which is independently strong. Recorded in the runbook as
  the intended upgrade.
- `NODE_ENV` is now read by `loadConfig`, solely so production can be refused a
  seed-enabled configuration. Nothing else branches on it.
