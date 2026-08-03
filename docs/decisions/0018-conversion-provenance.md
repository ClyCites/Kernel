# 0018 — A measured conversion has to show what it measured

Status: accepted
Date: 2026-08-03
Supersedes: nothing
Relates to: 0010 (conversion registry), 0011 (conversion verification), 0017 (dataset)

## Context

`registry.unit_conversion.basis` is a `ConversionBasis` — `measured`,
`published_standard`, `estimated`, `assumed_default`. Decision 0011 made that
column the thing a lender reads when it wants to know how much of a farmer's
tonnage rests on a real weighing.

The column does not carry enough to answer that. `measured` means somebody put
containers on a scale; it says nothing about how many, in what state, or of
which container. Twelve bags in one store on one morning and four hundred bags
across a district over a season produce the same value here. The §13 field
exercise will produce the first of those, and the lender view in work order D7
prints "conversion trust" as though the two were interchangeable.

The second problem is identity, not strength. The field question is not only
"how heavy is a bag" but "which bag". A kaveera packed tight and dried is not
the container the trader means when he says the same word. Coop C in the
adversarial seed exists precisely to model this: a bag there is a genuinely
different container, and the mismatch has to be legible to a later reader rather
than showing up as unexplained variance.

## Decision

Six nullable columns on `registry.unit_conversion`:

| Column | Purpose |
| --- | --- |
| `sample_size` | How many containers were weighed |
| `sample_min`, `sample_max` | The observed range |
| `sample_stddev` | Dispersion, so a wide sample is distinguishable from a tight one |
| `condition` | The state the commodity was in, e.g. `dried,tight` |
| `local_label` | What the container is called where it was weighed, e.g. `kaveera` |

And one constraint:

```sql
check (basis <> 'measured' or sample_size is not null) not valid
```

Nullable columns plus one constraint, rather than a `NOT NULL` sample_size,
because the other three bases legitimately have no sample. A published standard
is a citation, not a weighing.

## Why NOT VALID

Three rows already carry `basis = 'measured'`: the SI identities `kg→kg`,
`tonne→kg`, `gram→kg`. They measured nothing. There is no sample size that is
true of them, and inventing one would put a false claim in the registry that
append-only would never let us take back.

`NOT VALID` enforces the check on every subsequent INSERT and UPDATE while
leaving those three unexamined. It is not a weaker constraint for new rows; it
is the same constraint with an explicit, auditable grandfather list. That the
list is exactly three rows and exactly the SI identities is asserted in
`test/registry/metrics.test.ts` — "the SI definitions stay exempt" fails if a
fourth grandfathered row ever appears.

## FINDING: `ConversionBasis` conflates definition with measurement

`kg→kg` is not a measurement that happened to come out at 1.0. It is a
definition. Putting it under `measured` means the enum has no way to say "this
value is true by construction" and forces the grandfathering above.

A fifth value — `definitional` — would separate them cleanly and remove the need
for `NOT VALID` entirely. `ConversionBasis` lives in
`packages/schema/src/enums.ts`, which is vendored read-only. This is a candidate
for schema v0.3. Until then the constraint and its comment carry the finding.

## Metrics

`/metrics` gains `kernel_thin_sample_kg_total`: tonnage whose conversion is
`measured` but rests on fewer than ten containers.

Ten is not a statistical threshold and is not defended as one. It is the point
below which the word "measured" is doing more work than the evidence supports.
The adversarial seed's coop A weighs twelve bags, so it sits just above the line
— which is the intended reading: twelve is defensible, and the gauge should not
punish it. The number is a constant in `operations.controller.ts` so that moving
it is a code change with a diff rather than configuration drift.

Tonnage on a thin sample is reported separately from
`kernel_assumed_conversion_share` rather than folded into it. They are different
failures: one is "we did not weigh", the other is "we barely weighed", and an
operator who conflates them cannot tell which to fix.

## Consequences

- New measured factors cannot be written without a sample size. This is a
  rejection, not a quality flag, and it is a departure from P6 — but P6 governs
  a farmer's account of what happened, and a conversion factor is our own
  administrative record. Refusing to record our own unevidenced claim is not the
  same as refusing a farmer's.
- `condition` and `local_label` are free text and unvalidated. Constraining them
  would require a vocabulary that the field visits have not produced yet.
- The registry's read path selects the new columns, so anything already reading
  `UnitConversionRow` gets them without a further migration.
