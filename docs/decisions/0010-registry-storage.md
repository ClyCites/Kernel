# 0010 — Reference data lives in its own append-only schema

## Status

Accepted.

## Context

A record can say `raw_value: 12, raw_unit: "bag", normalized_kg: 1200,
conversion_id: <uuid>`. Until now the kernel accepted any well-formed UUID
there and stored the client's kilogram figure unchallenged.

That is worse than storing nothing. An unnormalized quantity is honestly
ambiguous and every reader knows it. A normalized one carries an implicit claim
— *someone converted this properly* — and downstream readers stop asking. The
`conversion_id` indirection exists precisely so that claim can be checked, and
we were not checking it.

Reference data also has a property records do not: it is *retroactively load
bearing*. Change what a maize bag weighs and every derived weight in the log
silently changes meaning, without a single record being rewritten.

## Decision

**Reference data lives in a `registry` schema, owned by the migrator, and is
append-only in the same sense facts are.**

- `kernel_app` holds `SELECT` and nothing else. `INSERT`, `UPDATE`, `DELETE`
  and `TRUNCATE` are explicitly revoked, and `CREATE` on the schema with them.
- A `before update or delete` trigger on every table raises `restrict_violation`
  even for the owning role. Privilege is the control; the trigger is the thing
  that catches a migration doing something thoughtless.
- A corrected factor is a **new row with a new id** carrying `supersedes`. Rows
  already pointing at the old id keep meaning what they meant.
- Seeding happens by migration. An operational write path — governance, review,
  a correction that does not need a deploy — is **future work**, deliberately
  not built here.

Six tables: `unit_conversion`, `observation_type`, `crop_code`, `admin_region`,
`grading_scheme`, `grading_scheme_value`.

## What the kernel now does at ingest

Three flags, none of which reject (invariant P6 — flag, never reject):

| Flag | Raised when |
| --- | --- |
| `conversion_unresolved` | the cited `conversion_id` is not in the registry |
| `conversion_mismatch` | `raw_value × factor` does not reproduce the client's `normalized_kg` |
| `conversion_scope_mismatch` | the conversion resolves but its commodity, region or validity window does not cover the record |

The middle one is the point. The kernel derives the number itself rather than
trusting the one it was handed.

## Consequences

**The seed is mostly `assumed_default`, and that is the honest state.** Only SI
relationships are `measured`; only the ICO 60 kg green coffee bag is
`published_standard`. Every Ugandan trade figure — the 100 kg bag, the 20-litre
debe, the matooke bunch — is a commonly quoted number nobody has weighed for us.
Marking them anything stronger would launder a guess into a measurement.

`/metrics` therefore exposes the share of normalized mass resting on an
unverified factor. It will read high. That is the number spec §13's field
validation exists to move, and hiding it would defeat the purpose.

**Admin region codes in the seed are placeholders.** The authoritative UBOS code
set is not loaded. Codes carry a vintage so that D6 stays answerable, but they
are development fixtures, not a gazetteer.

**Crop codes carry no external taxonomy.** `external_scheme` and
`external_code` exist as hooks and are null everywhere. Filling them in would
resolve D1 by accident.

**Region-scoped factors are currently unsatisfiable.** Delivery, Lot and Harvest
name a commodity but no boundary; Plot and Facility name a boundary but no
commodity. No record the kernel accepts carries both, so a district factor flags
wherever it is cited. This is recorded as a test in
`test/registry/conversion.test.ts` rather than softened by letting an unlocated
record borrow a local factor. It is a schema-shape question for §13.

**`ObservationType` and `GradingScheme` are defined in
`src/registry/types.ts`, not in `@clycites/schema`.** They are not record types
and the vendored schema stays untouched. If a second consumer appears, promote
them to `packages/registry-schema` then and not before.

## Rejected

**A config file or environment variable.** Not versioned, not auditable, and
impossible to point a stored record at.

**Storing conversions as records in `facts`.** They are not anybody's account of
something that happened. Mixing them in would make every supersession query walk
reference data.

**Letting the application write the registry.** The whole guarantee is that a
factor cannot change under a record that cites it. An application role with
`UPDATE` makes that a matter of code review rather than a matter of privilege.
