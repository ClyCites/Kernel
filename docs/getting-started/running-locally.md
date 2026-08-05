# Running locally

Requires Node 22 or newer, pnpm, and Docker.

```bash
cp .env.example .env          # dev credentials, fine as they are
docker compose up -d          # PostgreSQL 16 + PostGIS, MinIO — loopback only
pnpm install
bash scripts/install-hooks.sh # pre-commit secret scan
pnpm migrate                  # roles, schemas, tables, partitions
pnpm dev                      # http://localhost:3000
```

Check it is alive:

```bash
curl localhost:3000/v1/health
curl localhost:3000/v1/ready    # also checks the log is reachable
```

`ready` returns the schema version, which is the fastest way to tell whether the
database in front of you is the one you think it is:

```json
{"status":"ready","schema_version":"0.3.0"}
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | The kernel, watching for changes |
| `pnpm migrate` | Applies pending migrations and provisions partitions |
| `pnpm seed` | Writes the adversarial corpus into a running kernel |
| `pnpm test` | Everything, against a real PostgreSQL via Testcontainers |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm lint` | ESLint |
| `pnpm openapi` | Regenerates `apps/kernel/openapi.json` from the schemas |
| `pnpm docs:reference` | Regenerates the generated reference pages |
| `pnpm docs` | Serves this site at `http://localhost:8000` |
| `pnpm check:secrets` | Scans everything git tracks for credentials |

`pnpm test` starts its own database container and does not use the one from
`docker compose`. Docker must be running.

CI regenerates the OpenAPI document and fails if it differs from the committed
one, so `pnpm openapi` is not optional after touching a schema or a route. The
same is true of `pnpm docs:reference`.

## Writing a record

Ids are generated on the client — UUIDv7, so they sort by time and a device that
has been offline for a week collides with nothing. Submitting the same record
twice returns 200 and writes nothing.

```bash
curl -X POST localhost:3000/v1/records \
  -H 'content-type: application/json' \
  -d '{
    "id": "019fc3c0-0000-7000-8000-000000000001",
    "type": "delivery",
    "record_class": "observation",
    "schema_version": "0.3.0",
    "occurred_at": "2026-07-18T00:00:00+03:00",
    "occurred_at_precision": "day",
    "asserted_by": "019fc3c0-0000-7000-8000-0000000000aa",
    "lawful_basis": "special_data_consent",
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
curl 'localhost:3000/v1/records?type=delivery&subject=019fc3c0-…-0000000000bb&purpose=credit_assessment'
```

Reads of somebody else's records need a verified subject and a stated purpose.
[The authorisation model](../building/authorisation.md) explains what the gateway
is expected to supply and what happens when it does not.

## The seed corpus

`pnpm seed` needs a kernel already running with `SEED_INGEST_ENABLED=true`. It
writes four cooperatives, eighty farmers and around two hundred deliveries, all
marked `x-clycites-dataset: seed`, and prints a lender's-eye report on two
farmers at the end.

The corpus is deliberately not clean. Two of the four cooperatives cannot
reconcile their own mass balance, one applies a bag factor wrong by eighteen
percent, and one has no conversion at all. It is a fixture for the quality
flags, not a demo. See [Datasets](../concepts/datasets.md) for why fabricated
records live in the same tables as real ones rather than a separate database.

It is deterministic — the same `--seed` produces a byte-identical corpus, so a
diff of two runs is a regression test:

```bash
pnpm seed -- --plan-only --seed 4242 > a.json
pnpm seed -- --plan-only --seed 4242 > b.json
diff a.json b.json
```

## Building this site

```bash
python3 -m venv .venv-docs
.venv-docs/bin/pip install -r requirements-docs.txt
.venv-docs/bin/mkdocs serve
```

`mkdocs build --strict` is a required check in CI. A broken internal link fails
the build, because documentation that rots quietly is worse than none.
