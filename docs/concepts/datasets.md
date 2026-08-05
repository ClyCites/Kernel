# Datasets: seed and live

**What it prevents: a demonstration figure being quoted in a credit decision,
or a pitch deck, as though a farmer had produced it.**

## The problem with a separate database

The obvious way to keep fabricated data out of real data is a second database.
It fails in a specific, predictable way: the demo database is the one that is
convenient, so it accumulates the interesting cases; somebody exports a chart
from it; the chart circulates; nobody remembers which database it came from.
There is no marking on the number itself.

Worse, two databases drift. The seed corpus stops exercising the migration the
live schema just got, and the fixture that was meant to catch regressions
catches nothing.

## The discriminator

Every record carries a `dataset` value — `live` or `seed` — **on the row**. Both
live in the same tables, run through the same code path, and are subject to the
same constraints.

The marking travels with the record. A record extracted, quoted or exported
still says what it is. There is no context in which a seed record looks like a
live one, because the distinction is not "which database was it in" but a column
the record carries.

Writes are gated at the API: `x-clycites-dataset: seed` is required to write a
seed record, and the kernel refuses seed ingest entirely unless
`SEED_INGEST_ENABLED=true`. Production refuses to start with that flag on, and a
test asserts it.

Reads are scoped by dataset throughout. Nothing the seed writes can reach a live
read.

See [0017](../decisions/index.md).

## The corpus is adversarial, not representative

`pnpm seed` writes four cooperatives, eighty farmers and around two hundred
deliveries. It is deliberately not clean:

- two of the four cooperatives cannot reconcile their own mass balance;
- one applies a bag factor wrong by eighteen percent;
- one has no conversion at all;
- deliveries are confirmed, unconfirmed, confirmed under delegation, and
  confirmed against a version that was later corrected.

It is a fixture for the quality flags. A seed corpus where everything reconciles
proves only that the happy path works, which was never in doubt.

`test/seed/seed.test.ts` asserts what the corpus must contain, so the fixtures
cannot drift into being tidy.

See [0023](../decisions/index.md).

## Determinism

The same `--seed` produces a byte-identical corpus:

```bash
pnpm seed -- --plan-only --seed 4242 > a.json
pnpm seed -- --plan-only --seed 4242 > b.json
diff a.json b.json
```

A diff of two runs is therefore a real regression test — if a change to quality
flagging alters what the corpus produces, the diff shows exactly which records
moved.

## The `demo` profile

FAO-derived yield figures are barred from commercial promotional use by their
licence. A `demo` profile exists so that material intended for promotion can be
built without them, rather than relying on somebody remembering the restriction
at the moment they build a slide.

See [Data sources](../data-sources.md) for the licensing position on each
external dataset.
