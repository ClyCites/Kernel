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
docker compose up -d          # PostgreSQL 16 + PostGIS on port 5433
pnpm install
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
| `pnpm test` | Everything, against a real PostgreSQL via Testcontainers |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm lint` | ESLint |
| `pnpm openapi` | Regenerates `apps/kernel/openapi.json` from the schemas |
| `pnpm build` | Compiles to `dist/` |

`pnpm test` starts its own database container and does not use the one from
`docker compose`. Docker must be running.

CI regenerates the OpenAPI document and fails if it differs from the committed
one, so `pnpm openapi` is not optional after touching a schema or a route.

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

Errors are RFC 9457 problem documents and carry a correlation id.

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

## Layout

```
apps/kernel/
  migrations/        numbered, forward-only SQL — no down migrations
  src/storage/       pool, migrator
  src/records/       ingest, read, delegation, quality flags, repository
  src/sync/          device registry, outbox drain, change feed
  src/api/           controllers, problem details, OpenAPI generation
  test/              node:test + Testcontainers
packages/schema/     @clycites/schema, vendored and read-only
docs/decisions/      why things are the way they are
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
