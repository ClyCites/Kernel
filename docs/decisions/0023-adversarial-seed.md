# 0023 — The adversarial seed

Status: accepted
Date: 2026-08-03
Supersedes: nothing
Related: 0017 (dataset gate), 0018 (conversion provenance), 0019 (lawful basis), 0021 (fork semantics)

## Context

Work order D asks for a seed corpus that is adversarial rather than tidy: four
cooperatives, eighty farmers, roughly two hundred deliveries, and a set of
failure modes that the field actually produces. The point is not volume. It is
that the corpus should be able to *fail* — that a change which quietly breaks
conversion checking, or fork handling, or the delegation guard, should make the
seed stop reproducing the thing it was built to reproduce.

Everything is written through `POST /v1/records` with
`x-clycites-dataset: seed`. This is the first real use of the public contract by
something that is not a unit test, and several of the decisions below exist only
because writing through the contract exposed what the contract cannot do.

## Decision

### The corpus is deterministic, and the default seed is written down

`DEFAULT_SEED = 20260803`. `splitmix32` for the numbers, and a UUIDv7 whose
48-bit timestamp is a counter from a fixed epoch rather than `Date.now()`. No
call to `Math.random` and no call to the clock anywhere in `src/seed/`.

Determinism is defined over the *request documents*, not the stored rows:
`recorded_at` is set by the server and cannot be reproduced. `pnpm seed --
--plan-only` prints the plan, and two runs piped through `diff` is the whole
proof. The seed test asserts it directly.

### The calendar is fixed, and sits in the past on purpose

Every ordinary record falls between January and July 2026. A record whose
`occurred_at` is later than the server's clock raises `occurred_after_recorded`,
and a corpus where *every* record carries that flag proves nothing about the
one percent that are supposed to. The deliberate clock-skew cases are dated
2031, far enough out that the assertion cannot rot into a false pass.

This does mean the fixture calendar ages. It is fine forever going forward and
was only ever wrong before July 2026.

### Coop C's problem is a wrong factor, and a wrong factor is invisible in one record

This was the most useful thing the exercise turned up.

`conversion_mismatch` fires when `raw_value × factor ≠ normalized_kg`. Coop C's
app applies 100 kg per bag and stores 100 kg per bag. It is *internally
consistent* and it is *wrong*, and nothing in a single delivery can tell the
difference. The signal only appears when two independent measurements meet: the
lot is weighed on a weighbridge, and the sum of its bag-counted components does
not match. That is `mass_balance_discrepancy` on the Lot, not a conversion flag
on the Delivery.

So the corpus produces `conversion_mismatch` a second way, which is also how it
happens in the field: every third coop C load goes over the buyer's platform
scale, the officer types in what the scale said, and the app still cites the
100 kg factor. Now the two disagree inside one record and the kernel can say so.

The fixture is therefore honest about something the work order assumed: coop C
alone does not generate `conversion_mismatch`. Coop C *plus a second weighing*
does.

### The seed asserts what the kernel refuses

Four writes are expected to fail, and the test asserts both the refusal and
that nothing was left behind:

| Write | Refused because |
| --- | --- |
| Coop C's officer citing coop A's delegation | the delegation does not name him |
| A settlement under a delivery/harvest/observation delegation | money is outside the granted scope |
| A priced Delivery under `contract_performance` | s.9(1); only `special_data_consent` is available |
| An Inference | there is no write path for it at all — see below |

A seed containing only records the kernel accepted cannot demonstrate that it
refuses anything.

## Findings — things the work order asked for that the kernel cannot do

These are recorded rather than fixed. Each would be a change to something
outside D's scope.

### 1. `special_data_member_body` is not in the enum

J1 shipped nine lawful bases and s.9(3)(c) is not among them. Priced
cooperative deliveries are therefore written under `special_data_consent`,
which is the only s.9(3) ground the kernel exposes. Adding an enum value is a
change to the lawful-basis module, not a seed task.

The corpus still spreads across three grounds:
`contract_performance` (parties, plots, plantings, memberships, facilities,
delegations, lots, transfers), `special_data_consent` (priced deliveries,
obligations, settlements), and `consent` (observations — chosen because
`objectionStops('consent')` is true, so J2 has something an objection actually
stops).

### 2. There is no `sample` array

0012 added summary statistics to `registry.unit_conversion`:
`sample_size`, `sample_min`, `sample_max`, `sample_stddev`, `condition`,
`local_label`. There is no column for the individual weights, nor for
`measured_by`, `measured_at` or `instrument`.

Coop A's twelve kaveera live in `COOP_A_SAMPLE` and migration 0014 stores what
0012 can hold. The seed test recomputes n, min, max and stddev from the twelve
weights and asserts them against the row, so the two cannot drift. Who weighed
them, when, and on what, is prose in `source` — which is not queryable, and is
the gap.

### 3. The identity rows the addendum forbids already exist

Migration 0010 shipped `kg→kg`, `tonne→kg` and `gram→kg` with `basis: measured`.
0012's own comment already grandfathers them. The seed creates no identity rows,
which satisfies the instruction literally. Correcting the three existing ones to
`published_standard` with source `"SI"` — and retiring `kg→kg` — is a registry
migration with blast radius: `019fc600-0000-7000-8000-000000000002` is
referenced by `test/records/fulfilment.test.ts`.

Coop D has no conversion because no registry row covers a *basket* of anything,
not because beans have no factor — `bag→kg` for `crop.beans.dry` has existed
since 0010. No `litre→kg` row was added, because adding one would have given
coop D a factor and destroyed the `conversion_unresolved` case.

### 4. An Inference cannot be written through the public API

`POST /v1/records` dispatches on the entity name, and there is no `inference`
entity — by construction, since `factRecord` pins `record_class` to
`observation`. Nothing routes to the inference schema yet.

D5 asks for at least one Inference with `validated_by` pointing at a later
delivery. Under D2 — everything through the public API — that is currently
impossible. The plan contains a fully formed Inference and asserts that the
kernel refuses it, naming the reason. When work order G lands, that assertion
fails loudly and the seed has to be updated, which is better than an omission
nobody notices.

### 5. The lender view cannot be run as the lender

`ConsentService.decide` allows a self read or an asserter read and denies
everything else. A financier reading a farmer's deliveries gets
`consent_not_implemented` on every record, which is the deny-all guard working
exactly as designed.

D7's report is therefore produced by the cooperative, and says so in its own
header. The contrast it exists to show — a record that is trustworthy beside one
that only looks trustworthy — is unaffected.

## The one exception to "everything through the public API"

Migration 0014 inserts coop A's measured factor directly.
`registry.unit_conversion` has no write endpoint because it is reference data:
administered, not asserted, and with no `dataset` column to keep seed rows out
of live ones. Migration 0010 is the precedent. Every *record* still goes through
`POST /v1/records`.

## Consequences

- The seed test boots the real Nest container and writes ~720 records through
  HTTP. It takes about twelve seconds and runs in CI with everything else.
- Row counts, flag counts and the forty bylaw-authored records are asserted
  exactly. Fixture drift is a test failure, not a slow rot.
- The fork from D5 is asserted end to end: two tips, excluded from the
  fulfilment sum, counted separately, and the sum marked incomplete. That is
  0021 proven against real data rather than in a unit test.
- When consent lands (J-series), finding 5 should be revisited and the lender
  view run as the lender.
- When work order G lands, finding 4 breaks the seed on purpose.

## Rejected

**Writing rows directly to `facts.record`.** Faster, and it would have hidden
findings 1, 4 and 5 completely. The slowness is the point.

**Loosening the assertions so the corpus can vary.** A fixture whose assertions
are loose enough to survive drift is a fixture that no longer says anything.
