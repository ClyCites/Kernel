# ClyCites Kernel

The append-only record layer everything else sits on.

Applications never touch this database. They reach the kernel through a
versioned REST contract and never past it — that is the one architectural
invariant, and the reason the schema can change without seven applications
breaking.

```
Applications  →  Public API (/v1, OpenAPI 3.1)  →  Kernel  →  PostgreSQL
```

## What it does

Records are appended, never changed. A correction is a new record that
supersedes the one before it; a retraction hides a record from default reads
without removing it from the log. Every record carries who asserted it, and a
claim made on someone else's behalf must point at a delegation that authorised
it at the time it happened.

Sixteen core entities, one write path, one read path. The entity definitions
live in [`@clycites/schema`](packages/schema) and are the only definition of
what a record is; the kernel never restates a field.

## Running it

Requires Node 22+, pnpm, and Docker.

```bash
cp .env.example .env          # dev credentials, fine as they are
docker compose up -d          # PostgreSQL 16 + PostGIS on port 5433, loopback only
pnpm install
bash scripts/install-hooks.sh # pre-commit secret scan
pnpm migrate                  # creates roles, schemas, tables, partitions
pnpm dev                      # http://localhost:3000
```

Check it is alive:

```bash
curl localhost:3000/v1/health
curl localhost:3000/v1/ready     # also checks the log is reachable
```

### Commands

| Command | What it does |
|---|---|
| `pnpm dev` | The kernel, watching for changes |
| `pnpm migrate` | Applies pending migrations and provisions partitions |
| `pnpm seed` | Writes the adversarial corpus into a running kernel |
| `pnpm test` | Everything, against a real PostgreSQL via Testcontainers |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm lint` | ESLint |
| `pnpm openapi` | Regenerates `apps/kernel/openapi.json` from the schemas |
| `pnpm check:secrets` | Scans everything git tracks for credentials |
| `pnpm build` | Compiles to `dist/` |

`pnpm test` starts its own database container and does not use the one from
`docker compose`. Docker must be running.

CI regenerates the OpenAPI document and fails if it differs from the committed
one, so `pnpm openapi` is not optional after touching a schema or a route.

### The seed

`pnpm seed` needs a kernel already running with `SEED_INGEST_ENABLED=true`. It
writes four cooperatives, eighty farmers and around two hundred deliveries
through `POST /v1/records`, marked `x-clycites-dataset: seed`, and prints a
lender's-eye report on two farmers at the end. Nothing it writes can reach the
live corpus; the gate is enforced server-side.

The corpus is deliberately not clean. Two of the four cooperatives cannot
reconcile their own mass balance, one applies a bag factor that is wrong by
eighteen percent, and one has no conversion at all. It is a fixture for the
quality flags, not a demo.

It is deterministic. The same `--seed` produces a byte-identical corpus, so a
diff of two runs is a real regression test:

```bash
pnpm seed -- --plan-only --seed 4242 > a.json
pnpm seed -- --plan-only --seed 4242 > b.json
diff a.json b.json
```

`test/seed/seed.test.ts` asserts what the corpus must contain and fails if the
fixtures drift.

## Submitting a record

Ids are generated on the client — UUIDv7, so they sort by time and a device
offline for a week collides with nothing. Submitting the same record twice
returns 200 and writes nothing.

```bash
curl -X POST localhost:3000/v1/records \
  -H 'content-type: application/json' \
  -d '{
    "id": "019fc3c0-0000-7000-8000-000000000001",
    "type": "delivery",
    "record_class": "observation",
    "schema_version": "0.2.0",
    "occurred_at": "2026-07-18T00:00:00+03:00",
    "occurred_at_precision": "day",
    "asserted_by": "019fc3c0-0000-7000-8000-0000000000aa",
    "from_party": "019fc3c0-0000-7000-8000-0000000000bb",
    "to_party": "019fc3c0-0000-7000-8000-0000000000aa",
    "commodity": "crop.maize.grain",
    "quantity": {
      "raw_value": 12,
      "raw_unit": "bag",
      "raw_unit_label": "kaveera",
      "normalized_kg": 1416,
      "conversion_id": "019fc3c0-0000-7000-8000-0000000000cc",
      "measurement_method": "coop_weighed"
    },
    "location": "019fc3c0-0000-7000-8000-0000000000dd"
  }'
```

Then read it back, correct it, and walk the chain:

```bash
curl localhost:3000/v1/records/019fc3c0-0000-7000-8000-000000000001
curl localhost:3000/v1/records/019fc3c0-0000-7000-8000-000000000001/chain
curl 'localhost:3000/v1/records?type=delivery&subject=019fc3c0-0000-7000-8000-0000000000bb'
```

A default read shows the tip of every chain with retracted records absent.
Superseded and retracted records stay addressable by id, because a lender
auditing a dispute needs to see what was claimed before it was corrected.

## The API

`apps/kernel/openapi.json` is generated from the Zod schemas — never written by
hand, and checked in so a consumer can generate a client without running
anything.

| | |
|---|---|
| `POST /v1/records` | Append one record |
| `GET /v1/records` | Current records, filtered and paged |
| `GET /v1/records/{id}` | Any record, including superseded and retracted |
| `GET /v1/records/{id}/chain` | Every version, oldest first |
| `GET /v1/inferences/{id}` | The inference namespace, by name only |
| `POST /v1/devices` | Register a device |
| `POST /v1/sync/outbox` | Drain a batch captured offline |
| `GET /v1/sync/changes` | Everything appended since a cursor |
| `GET /v1/health`, `GET /v1/ready` | Liveness, readiness |
| `GET /v1/metrics` | Prometheus text. Includes the share of normalized mass resting on an unverified conversion factor — it reads high, and that is the point |

Errors are RFC 9457 problem documents and carry a correlation id.

### The registry is public

`GET /v1/registry/**` takes no subject header and passes through no consent
gate. It serves unit conversions, crop codes, administrative boundaries and
grading vocabularies — data with no subject.

| | |
|---|---|
| `GET /v1/registry/conversions` | Filter by unit, commodity, region, basis |
| `GET /v1/registry/conversions/{id}` | One factor, with the individual weighings behind it, who took them, when and on what |
| `GET /v1/registry/observation-types[/{code}]` | The observation vocabulary |
| `GET /v1/registry/crop-codes[/{code}]` | The crop vocabulary |
| `GET /v1/registry/admin-regions[/{code}/{vintage}]` | Boundaries. Both parts required — a district code alone is ambiguous across time |
| `GET /v1/registry/grading-schemes[/{scheme}]` | Grading vocabularies and their permitted values |

This is deliberate. A delivery cites a `conversion_id`; if resolving it needed a
credential, then verifying a weight would need our permission, and a record you
need our permission to verify is a record you are trusting us for. See
[docs/decisions/0024-registry-read-api.md](docs/decisions/0024-registry-read-api.md).

Rows are immutable — corrections supersede — so responses carry
`Cache-Control: public, max-age=86400, immutable`. **Cache them.** It is the
only surface without an authenticated caller, so it is rate limited per address
(`REGISTRY_RATE_LIMIT`); that counter lives in one process, which makes it per
replica and no substitute for a limit at the gateway.

One thing the generated document cannot express: the schema's cross-field rules
(`on_behalf_of` requires `delegation`, `normalized_kg` requires
`conversion_id`) are Zod refinements with no JSON Schema equivalent. The kernel
enforces them; a client generated from the document alone will not know about
them until it gets a 422.

## The invariants

Six things hold, each with a test that fails when broken.

1. **Append-only.** `kernel_app` holds INSERT and SELECT and nothing else.
   There is no UPDATE grant, so there is no privileged path by which a
   correction could overwrite a record — not a code review rule, a missing
   permission. *(`test/invariants/storage.test.ts`)*

   With one honest qualification. That grant binds the application, not the
   database: `clycites_owner` owns the tables and Postgres offers no way to
   revoke a right from an owner durably. A trigger refuses deletion of any
   `live` row for every role, the audit log records the DDL that would be needed
   to remove it, and anchoring will eventually make a deletion provable. The
   claim to make is "the running kernel cannot alter a record", not "records
   cannot be altered" — see
   [`docs/decisions/0001`](docs/decisions/0001-append-only-enforcement.md).
2. **Observations and inferences never mix.** Separate Postgres schemas,
   separate tables, separate endpoints. An inference is reachable only by asking
   for it by name. *(`test/records/read.test.ts`)*
3. **Provenance is mandatory.** `asserted_by` always; `on_behalf_of` requires a
   delegation that was active when the event occurred, verified at ingest.
   *(`test/records/ingest.test.ts`)*
4. **Flag, never reject.** Implausible weights, unnormalized quantities, a
   delivery to oneself, a lot whose components do not add up — all stored with a
   quality flag. Only structurally impossible records are refused. *(`test/records/ingest.test.ts`, `test/records/entities.test.ts`)*
5. **Offline by default.** Client-generated ids, idempotent ingest, batch drain,
   cursor-based pull. *(`test/sync/sync.test.ts`)*
6. **Non-custodial.** No wallet, no balance, no funds. Obligations are recorded
   and settlements are referenced; the money moves somewhere else.
   *(`test/schema-pin.test.ts`)*

## Operations

### The audit log

Every disclosure, every append, and every refusal is recorded in the `audit`
schema. It is a statutory record rather than a log: DPPA s.24(1)(c) requires
telling a data subject who has accessed their data, and s.16(4) requires
notifying those parties when a record is corrected — neither is answerable from
anything else.

It holds ids and query descriptors. **Never record bodies**, enforced by a type
that cannot represent one, a runtime filter, and a size cap in the database.
`kernel_app` has INSERT and no SELECT: reading the log is a privileged operator
path, run as the owner. Entries cannot be updated or deleted by anyone, and
schema changes write their own entry — which is what makes the qualification on
invariant 1 above bearable.

Set `AUDIT_SHIP_URL` to copy entries off-box. That copy is the tamper evidence,
so it is worth having somewhere an operator with credentials to this database
cannot reach. Shipping is asynchronous and best effort and can never fail a
request; the database write is neither, and will.

See [`docs/decisions/0025`](docs/decisions/0025-audit-log.md), including what it
does not yet do.

[`docs/runbook.md`](docs/runbook.md) is the procedure for a breach, a restore, a
secret rotation, and the monthly verification the DPPA requires. Read §1 before
you need it.

```bash
BACKUP_PASSPHRASE=... scripts/backup.sh          # encrypted dump + manifest
BACKUP_PASSPHRASE=... scripts/restore.sh backups/<stamp> <url>
```

The backup writes a manifest of row counts, primary-key fingerprints, every
constraint with its validated flag, and every table grant. The restore
regenerates it and diffs — exit 0 only on an exact match, because append-only
leaves no reconciliation path if a restore silently drops a constraint. It
refuses any target database not named `restore`, `test`, or `scratch`.

`test/ops/` runs both scripts for real and asserts the configuration no
functional test would notice: nothing in the data tier published beyond
loopback, a complete `.env.example`, production refusing to start with seed
ingest enabled, and no route resembling a bulk export.

## Layout

```
apps/kernel/
  migrations/        numbered, forward-only SQL — no down migrations
  src/storage/       pool, migrator
  src/records/       ingest, read, delegation, quality flags, repository
  src/sync/          device registry, outbox drain, change feed
  src/api/           controllers, problem details, OpenAPI generation
  test/              node:test + Testcontainers
  test/ops/          backup, restore, and configuration exposure
packages/schema/     @clycites/schema, vendored and read-only
scripts/            backup, restore, secret scan, hook install
docs/decisions/      why things are the way they are
docs/runbook.md      what to do when it goes wrong
```

No ORM. SQL is written where it runs, in `src/storage` and
`src/records/record.repository.ts`.

## Decisions

Anything the brief did not settle is recorded in
[`docs/decisions/`](docs/decisions), including why `superseded_by` is derived
rather than stored, why a reused id is a conflict, and why sync keeps no
server-side cursor.

## Out of scope

Authentication (Authentik supplies a verified subject; the kernel trusts it),
consent beyond a deny-all stub, anchoring, media bytes, the inference engine,
scoring and pricing, USSD and SMS gateways, and the seven applications
themselves.
