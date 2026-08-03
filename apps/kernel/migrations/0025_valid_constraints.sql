-- 0025 — Two advisory constraints made real, and two districts that were
-- missing. Work order P1.
--
-- NOT VALID means the rows already in the table were never checked. New rows
-- are, so the constraint is not useless — but it leaves the table in a state
-- where nobody can say how many violations it holds, and a constraint whose
-- exceptions are unenumerated is a constraint that is quietly advisory.
--
-- Both are made VALID here, and in both cases the exception turns out to be a
-- short, closed, nameable list. That list moves out of a comment and into the
-- check, which is the actual fix: the rows that cannot satisfy the rule are
-- now named in the schema, and no new row can join them.
--
-- FINDING, reported rather than fixed. Both tables are immutable — 0009 puts
-- a BEFORE UPDATE OR DELETE trigger on every registry table that raises for
-- every role including the owner. So the offending rows cannot be corrected,
-- only enumerated. See the notes on each below; the 0012 one is a data defect
-- with a consequence on `/metrics`, not merely an untidy comment.

/* ── 0012: measured factors must show their sample ─────────────────────── */

-- The exemption is three rows: kg→kg, tonne→kg, gram→kg. They are the SI
-- identities, they measured nothing, and no honest sample size exists.
--
-- FINDING. Their basis is wrong. `published_standard` is already in
-- ConversionBasis and SI is precisely a published standard, so the correct
-- value was available when 0010 seeded them and `measured` was a mistake
-- rather than a gap in the enum — which is what 0012's comment concluded when
-- it asked for a fifth value.
--
-- The consequence is not cosmetic. Every quantity recorded directly in
-- kilograms cites conversion ...0001, so `kernel_normalized_kg_total` and
-- `kernel_assumed_conversion_share` currently report that mass as resting on
-- a measured factor. The share of tonnage that has actually been weighed is
-- overstated by exactly the mass that was never converted at all.
--
-- The rows cannot be updated. Correcting them means a migration that disables
-- the immutability trigger, which is a deliberate act with a DDL entry behind
-- it and is not something to slip into a batch of small fixes. Enumerated
-- here so that the defect is visible in the schema until then.

alter table registry.unit_conversion
  drop constraint unit_conversion_measured_shows_sample;

alter table registry.unit_conversion
  add constraint unit_conversion_measured_shows_sample check (
    basis <> 'measured'
    or sample_size is not null
    or id in (
      '019fc600-0000-7000-8000-000000000001',  -- kg    → kg,    SI identity
      '019fc600-0000-7000-8000-000000000002',  -- tonne → kg,    SI
      '019fc600-0000-7000-8000-000000000003'   -- gram  → kg,    SI
    )
  );

comment on constraint unit_conversion_measured_shows_sample
  on registry.unit_conversion is
  'A measured factor shows its sample. The three exempt ids are SI identities '
  'seeded with the wrong basis in 0010 and immutable since — see 0025.';

/* ── 0020: every observation type carries a citation ───────────────────── */

-- The exemption is three codes seeded in 0010 with no source: soil.ph,
-- pest.incidence, storage.condition. They are exactly what the rule exists to
-- prevent — plausible, unused, registered because somebody could imagine
-- wanting them — and there is no honest citation to backfill. Inventing one
-- would be worse than the gap.
--
-- Naming them in the check rather than leaving the constraint NOT VALID is
-- what makes the gap finite. Under NOT VALID a fourth uncited row could be
-- added by any path that bypassed the constraint's future enforcement; under
-- this, it cannot, and the day one of the three acquires a real citation the
-- edit is deliberate and visible here.

alter table registry.observation_type
  drop constraint observation_type_cited;

alter table registry.observation_type
  add constraint observation_type_cited check (
    (source is not null and length(btrim(source)) > 0)
    or code in ('soil.ph', 'pest.incidence', 'storage.condition')
  );

comment on constraint observation_type_cited on registry.observation_type is
  'Every type carries a citation. The three exempt codes are uncited rows '
  'seeded in 0010 that cannot be corrected or withdrawn — see 0025.';

/* ── two districts the seed uses and the registry did not hold ─────────── */

-- Cooperatives B and D place their plots in Kiryandongo and Nebbi. Neither
-- code was in registry.admin_region, so the season calendar could not be
-- scoped to them and — the part that mattered — a conversion check against a
-- record in either district resolved to "cannot tell" and was reported as
-- "does not apply". See 0033 for the three-valued check that replaces it.
--
-- Both are 2020-vintage districts, consistent with every other row here. The
-- source is the same UBOS district list the rest of the table came from.

insert into registry.admin_region
  (code, vintage, name, level, parent_code, parent_vintage, source)
values
  ('UG.KIRYANDONGO', '2020', 'Kiryandongo', 'district', 'UG', '2020',
   'UBOS district list, 2020 boundaries — see docs/data-sources.md'),
  ('UG.NEBBI', '2020', 'Nebbi', 'district', 'UG', '2020',
   'UBOS district list, 2020 boundaries — see docs/data-sources.md')
on conflict (code, vintage) do nothing;
