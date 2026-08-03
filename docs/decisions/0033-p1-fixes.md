# 0033 — The six fixes: what they were, and what two of them turned out to be

Work order P1. Six items, of which two were already built, two were smaller
than they looked, and two changed what a number in the corpus means.

## `NOT VALID` made `VALID`, and the rows that could not comply

`NOT VALID` on a check constraint means the rows already in the table were
never tested. New rows are, so it is not useless — but it leaves a table in a
state where nobody can say how many violations it holds, and it makes the
constraint a statement of intent rather than a fact.

Both named constraints are now `VALID`. In both cases the reason they were not
is that a small number of seeded rows genuinely cannot satisfy them, and the
registry is immutable — 0009 puts a `BEFORE UPDATE OR DELETE` trigger on every
table there that raises for every role including the owner. So the rows cannot
be corrected in place and cannot be withdrawn.

What 0025 does instead is enumerate them in the constraint itself:

```sql
check (basis <> 'measured' or sample_size is not null
       or id in ('…0001', '…0002', '…0003'))
```

That is a different thing from `NOT VALID`. The exception is now closed,
named, and checked against every row in the table — no fourth row can join it,
and the day one of the three is corrected the edit is deliberate and lands
here rather than passing silently.

### FINDING — the three exempt conversions are misclassified, and it shows on `/metrics`

`019fc600-…0001`, `…0002` and `…0003` are kg→kg, tonne→kg and gram→kg. They
are SI identities. They are seeded with `basis = 'measured'`, which is wrong:
they measured nothing, and `published_standard` is already in `ConversionBasis`
and is precisely what SI is. 0012's comment concluded the enum needed a fifth
`definitional` value; on the evidence it did not — the correct value existed
and the wrong one was chosen.

The consequence is not cosmetic. Every quantity recorded directly in kilograms
cites `…0001`. So `kernel_normalized_kg_total{basis="measured"}` and the
assumed-conversion share currently report all of that mass as resting on a
measured factor, and the proportion of tonnage that has actually been weighed
is overstated by exactly the mass that was never converted at all. Coop A's
twelve weighed bags are the only genuinely measured factor in the registry.

Not fixed here, because fixing it means a migration that disables the
immutability trigger to update three registry rows, and that is a deliberate
act with its own DDL entry behind it rather than something to fold into a
batch of small corrections. Enumerated in the schema so the defect is visible
until it is decided.

### FINDING — the three uncited observation types

`soil.ph`, `pest.incidence` and `storage.condition` were seeded with no
source. They are exactly what `observation_type_cited` exists to prevent:
plausible, unused, registered because somebody could imagine wanting them.
There is no honest citation to backfill and inventing one would be worse than
the gap. They are exempt by name.

## The delete trigger was already built

`0016_no_live_deletion.sql` already implements what P1 asked for, in the shape
P1 asked for it: `BEFORE DELETE` on `facts.record`, `inference.record` and
`kernel.record_key`, permitting `dataset = 'seed'` and raising
`restrict_violation` on `live`, for every role including the owner. Fifty-seven
triggers once propagated across partitions.

Its header comment already carries the honest limit — an owner can drop the
trigger and then delete whatever they like, and what the trigger buys is that
dropping it is DDL and 0025's predecessor logs DDL. There is a test in
`test/invariants/audit.test.ts` that drops it, asserts the drop was logged as
`schema.ddl`, and puts it back.

Nothing to do. Reported rather than rebuilt.

## The rate limiter was already built; the cache was not

`RateLimitMiddleware` already existed: fixed-window, per-IP, RFC 7807 on 429,
applied to `v1/registry/*` and nothing else, with its own finding recorded
about being per-replica and in-process.

What was missing is the cheaper half. The cheapest rate limit is not serving
the request, and registry rows are immutable by trigger, so a response from
that surface cannot go stale within a process lifetime. `RegistryCacheInterceptor`
adds two things:

- an in-process TTL cache, which spares the database — a repeat request never
  reaches Postgres;
- a strong `ETag` and `If-None-Match` handling, which spares the network — a
  client that already holds the answer gets 304 and no body, and these clients
  are on the connections they are on.

Three decisions inside it worth stating.

**A cached hit still spends rate-limit budget.** The middleware runs before the
interceptor and is not bypassed. A limiter that only counts expensive requests
can be defeated by making cheap ones, and the limit bounds traffic as well as
load.

**404s are not cached.** They are cheap, and they are the one registry answer
that can legitimately change without a deploy: a code inserted by a migration
turns a 404 into a 200.

**It is scoped to one controller, deliberately.** Every other route in the
kernel is consent-dependent, so its correct answer differs per caller and a
URL-keyed cache would serve one subject's records to another. That is not a
hypothetical, it is the whole failure mode of caching an authorisation-bearing
API. The interceptor additionally refuses to answer any request carrying a
subject header, so the guard does not rest on the mounting alone.

## The region check was answering "fine" when it meant "cannot tell"

Two districts the seed uses — `UG.KIRYANDONGO` and `UG.NEBBI` — were not in
`registry.admin_region`. Added by 0025 with their boundary vintage.

The more consequential half is the three-valued split. `applies()` returned a
boolean, and a record that stated no region at all fell through the same branch
as a record that stated the wrong one. Both produced
`conversion_scope_mismatch`, which is a finding against the record.

It now returns `'covers' | 'mismatch' | 'unresolvable'`:

- unit, commodity and validity window are answerable from every record, so a
  disagreement there is a `conversion_scope_mismatch`;
- a factor with no region is general and cannot be contradicted;
- a record that names no region, or names one the registry does not hold, is
  `region_unresolvable`;
- a record that names a known region which is not the factor's region is a
  `conversion_scope_mismatch`, and until 0025 there was no such case because
  neither of the two districts involved was in the registry.

### The tally moved, and the direction is the finding

`conversion_scope_mismatch` stood at 1. That single record was the Kapchorwa
fixture: a delivery citing a district-scoped factor while carrying no district
of its own. Under the split it is `region_unresolvable`, because the factor may
well hold for it and nothing in the record says either way.

So the count was 1 for the reason suspected — not because scope mismatches are
rare, but because the comparison was resolving to unknown and unknown was being
reported as wrong. Left alone the flag would now stand at 0.

A new adversarial fixture supplies a real one: a coop D delivery of
`crop.beans.dry` citing the maize bag factor. Commodity is on every delivery,
so the comparison has an answer and the answer is no. A clerk picking the wrong
row off a list of factors is the ordinary way this happens.

### FINDING — the region limb of the check is unreachable

Worth stating separately, because it is the larger result. No entity in the
schema carries both a quantity and an `admin_region`. Plot and Facility have a
region and no quantity; Delivery, Harvest and Lot have a quantity and no
region. So a district-scoped factor can never be *satisfied* by any record the
kernel accepts, and after the split it can never be *contradicted* either —
every citation of one resolves to `region_unresolvable`.

That was previously invisible, because the check was reporting the gap as a
data defect on a farmer's record. It is now visible as an unresolvable count,
which is where a schema gap belongs. It is a schema-shape question for spec
§13 and not something to soften by letting an unlocated record borrow a
district factor.

## FAOSTAT, and where its numbers may be used

FAOSTAT is CC BY 4.0, but the FAO Statistical Database Terms of Use also bar
use "in connection with promoting a commercial enterprise". A lender view is a
document put in front of a financier to show what the product can do, which is
promoting a commercial enterprise. Attribution does not cure that — the
restriction is on the purpose, not on the crediting.

So the seed takes a `YieldProfile`. `faostat` is the default and stays
internal. `demo` uses `DEMO_YIELD_KG_PER_HA`, invented outright — deliberately
not a rounding of the FAOSTAT figures, because a rounding is still derived from
them. Every artifact prints which profile produced it in its header, because a
reader who cannot tell whether a number came from FAO or from us has been
misled in either direction.

## The smallholder haircut

A FAOSTAT national yield is total production over total area harvested, and
that denominator includes commercial estates with irrigation, certified seed
and mechanised handling. Every farmer in this corpus holds one to four acres.

`SMALLHOLDER_YIELD_HAIRCUT = 0.72` applies to both profiles. It sits inside the
range regional smallholder studies tend to report, but no single publication
supports the figure, so it is recorded in `docs/data-sources.md` under
assumptions and not under sources. That distinction is the point of the
document: "seeded from public data" must not be sayable about a number nobody
published.

## Not in this work order

`facts_lawful_basis_stated` and `inference_lawful_basis_stated` from 0013 are
still `NOT VALID`. P1 named 0012 and 0020 only, and 0013's case is different in
kind — the rows that escape it are records, not registry rows, and what to do
about a stored record with no lawful basis is a question about the record
rather than about the constraint.

The rate limiter remains per-replica and in-process, and so does the cache.
Both are adequate for a single-instance kernel behind a gateway and neither is
a substitute for a limit at the edge.
