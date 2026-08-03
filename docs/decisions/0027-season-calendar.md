# 0027 — The season calendar is a registry table, not a schema change

**Status:** accepted, deferring open decision **D5**
**Migration:** `0018_season_calendar.sql`
**Code:** `src/registry/`, `GET /v1/registry/seasons`

## The question this does not answer

D5 asks whose calendar wins. Uganda's main growing regions are bimodal — two
seasons a year — and Karamoja is unimodal. A cooperative in Masaka and a
cooperative in Nebbi do not mean the same thing by "this season", and neither
of them necessarily means what the national statistics office means. When a
coop's working definition of a season differs from the published one, which is
the kernel's answer?

D5 is still open. A table that can hold both definitions, keyed by region and
marked with where each came from, is the shape that keeps the question
answerable. It is not the answer.

## The shape

`registry.season_calendar`, keyed on `(region_code, region_vintage, label)` with
a foreign key into `registry.admin_region` so a season cannot be recorded
against a region that does not exist at that vintage. `starts_on` and `ends_on`
are dates; `basis` is `published` or `observed`; `source` is required and
non-blank.

Append-only, via the same `registry.refuse_mutation()` trigger every other
registry table uses. `kernel_app` may select and nothing else.

Lookups take the most specific region that matches: a district row beats the
national one, and a lookup that finds neither returns null rather than a
plausible guess.

## `SeasonLabel` stays an opaque string

The schema treats a season label as a string and this does not change that. The
alternative — an enum, or a structured `{year, cycle}` — would mean that the day
somebody in the field tells us Karamoja's season is not `2026A` at all, the fix
is a schema version, a migration, and a redeploy.

With resolution in a table, that day's fix is an `INSERT`. That is the entire
argument.

## What is seeded, and what is not

**One row.** Country-level `UG`, label `2026A`, 2026-02-01 to 2026-07-31,
`basis: 'published'`, cited to the FAO GIEWS Uganda Country Brief of 8 May 2026.

That brief says first-season crops in the bimodal areas "were planted in
February and March 2026, and will be harvested in June and July". The row's
dates are those planting and harvest windows. They are **not** a stated season
boundary — GIEWS does not publish one — and the row's note says so.

Everything else is empty, on purpose:

- **No district rows.** An earlier draft copied the national dates onto
  `UG.MASAKA`, `UG.KIRYANDONGO`, `UG.KAPCHORWA` and `UG.NEBBI`. That would have
  manufactured a precision the source does not have: it would look like four
  regional observations and be one national statement repeated. (It would also
  have failed the foreign key — `UG.KIRYANDONGO` and `UG.NEBBI` are not in
  `registry.admin_region`, which is a separate gap worth recording.)
- **No `2026B` row.** The brief says nothing about the second season. An empty
  row is the honest representation of that.
- **No Karamoja row.** The brief says the unimodal Karamoja rainy season
  "normally spans from April to August", but `2026A` is a bimodal-season label
  and applying it to a region that does not have two seasons would be worse than
  having no row. The note on the national row records the exclusion.
- **Nothing with `basis: 'observed'`.** Nobody has been to a field.

A caller asking for a season with no row gets nothing. That is the correct
answer and it is visibly different from a wrong one.

## What would change our mind

- If field observation shows coop season boundaries routinely differ from the
  national windows by more than a few weeks, D5 resolves toward the coop's
  definition and the `observed` rows become the primary source.
- If they almost never differ, D5 resolves toward the national calendar and this
  table shrinks to a lookup nobody overrides.
- If a coop needs two overlapping definitions of the same label at once, the
  primary key is wrong and needs an asserter column — at which point this stops
  being registry data and becomes a claim, like party links (0026).
