# 0024 — the registry is public, and the sample is stored

Status: accepted
Date: 2026-08-03
Supersedes: nothing. Extends 0012 (conversion provenance).

## The problem

The kernel could write conversion provenance and could not read it back out.

A delivery record says `12 bag -> 1200 kg` and cites a `conversion_id`. That
citation is the mechanism the whole platform rests on: it is what lets a lender
distinguish a quantity somebody weighed from a quantity somebody assumed. But
until now there was no route that resolved a conversion id to anything. The
apparatus was write-only.

That is not a missing endpoint. It breaks the thesis. The claim is that a third
party can verify a record *without trusting ClyCites*. A weight they cannot
dereference to a factor, a basis and a sample is a weight they have to take on
faith, which is the situation the platform exists to end.

## What was actually stored

Correction to a premise that had been circulating: migration 0012 did **not**
record twelve weighings. It added `sample_size`, `sample_min`, `sample_max`,
`sample_stddev`, `condition` and `local_label` — six summary columns. The twelve
numbers behind them existed in the seed fixture and in an English sentence in
`source`. `measured_by`, `measured_at` and `instrument` did not exist at all.

Four statistics cannot be recomputed into the sample they came from. So an
endpoint that returned everything the registry held would still not have let
anybody check the summary, because there was nothing to check it against.
Migration 0015 therefore had to create the storage before the read path could be
worth having.

## Decisions

### The sample is rows, not a JSON column

`registry.unit_conversion_sample`, one row per weighing, keyed
`(conversion, ordinal)`, immutable under the same `refuse_mutation` trigger as
every other registry table, with a trigger refusing an ordinal beyond the
declared `sample_size` and refusing any row against a factor that declares no
sample. A JSON blob would have made "the summary restates the sample" an
assertion in application code. As rows it is a database constraint.

`condition` is per sample, not per factor. Two of coop A's twelve bags were
weighed damp; that is not noise to be tidied away, it is the explanation for a
2.68 kg standard deviation, and a single factor-level `dried,tight` would have
concealed it.

### A superseding row, not a backfill

The provenance was attached to a **new** conversion
`019fc600-…-000000000051`, superseding `…0050`, rather than added to `…0050`.

Two reasons, and the second is the real one:

1. The immutability trigger refuses `update` on `registry.unit_conversion` even
   to the schema owner. Working around it would have meant disabling it.
2. Records already cite `…0050`. Attaching evidence to that row would
   retroactively give those records provenance they did not have when they were
   written. A record must keep the meaning it had at the moment of writing.
   `…0050` remains readable, and says what replaced it.

### The registry is unauthenticated and ungated

`GET /v1/registry/**` takes no subject header, passes through no consent guard,
and is served with `Cache-Control: public, max-age=86400, immutable`.

The registry holds unit conversions, crop codes, administrative boundaries and
grading vocabularies. There is no data subject anywhere in it. Gating it would
be theatre — and worse than theatre, because verification that requires our
permission is not verification. This is the first surface where the kernel's
openness is a feature rather than a risk, and the reason it is safe is
structural: the controller can inject `RegistryRepository` and nothing else, and
that repository holds `select` on the `registry` schema and nothing else. A test
in `test/ops/exposure.test.ts` fails if the controller ever reaches a record
service.

### Collections do not carry samples

A single-conversion fetch returns the sample. A collection does not. A lender
filtering a list does not need twelve rows per factor; a scraper would like them
very much. One fetch by id gets them.

### Rate limiting, and what it is not

The public surface is limited per address by an in-process fixed window
(`REGISTRY_RATE_LIMIT`, default 600 per minute). This is stated in
`rate-limit.middleware.ts` as a finding rather than hidden: the counter lives in
one process, so it is per replica, it resets on deploy, and behind N instances
the effective limit is N times the configured one. It is adequate for a
single-instance kernel and is not a substitute for a limit at the edge. When the
gateway grows one, this becomes the second line.

## Consequence for the export guard

`test/ops/exposure.test.ts` forbids bulk export. A registry collection endpoint
is bulk, and the guard did not fire on it — its route-name regex does not match
`conversions`. Rather than add an exception, the guard was read again and
narrowed to what it always meant: no bulk export of **personal data**. The s.16(4)
reasoning it encodes — that an export makes the recipient an independent holder
we owe correction notices to indefinitely — has no purchase on data with no
subject.

Its real defect was elsewhere. The second test checked a hardcoded list of three
controllers, so a fourth would have been silently exempt. That list is now
derived from the directory.

## Consequence for the lender view

The report now resolves every cited factor and prints `measured (n=12)` beside
`assumed_default`, with the twelve weights, the officer, the date and the
instrument underneath the first and "a convention, not a measurement" underneath
the second. Both cooperatives quote 100 kg per bag. Only one of them has ever
checked.

That contrast is the artifact this kernel exists to produce.
