-- 0010 — Registry seed.
--
-- Honesty rules for this file:
--
--   * `measured` is used only where the factor is a definition (SI prefixes).
--   * `published_standard` is used only where a named external standard fixes
--     the number and the standard is cited in `source`.
--   * everything else is `assumed_default` — a debt marker, not a value we
--     stand behind. The share of ingested tonnage resting on these is exposed
--     on /metrics precisely so the debt is visible rather than forgotten.
--
-- Spec §13's field validation has not been run. When it is, corrections arrive
-- as new rows pointing at these through `supersedes`; nothing here is edited.

-- ── admin regions ─────────────────────────────────────────────────────────
--
-- Placeholder codes. The authoritative UBOS code set is not loaded, so these
-- are development fixtures with a real vintage attached, not a gazetteer.

insert into registry.admin_region
  (code, vintage, name, level, parent_code, parent_vintage, source) values
  ('UG',              '2020', 'Uganda',     'country',  null, null,   'placeholder for development'),
  ('UG.KAMPALA',      '2020', 'Kampala',    'district', 'UG', '2020', 'placeholder for development'),
  ('UG.MBALE',        '2020', 'Mbale',      'district', 'UG', '2020', 'placeholder for development'),
  ('UG.KAPCHORWA',    '2020', 'Kapchorwa',  'district', 'UG', '2020', 'placeholder for development'),
  ('UG.MASAKA',       '2020', 'Masaka',     'district', 'UG', '2020', 'placeholder for development'),
  ('UG.KASESE',       '2020', 'Kasese',     'district', 'UG', '2020', 'placeholder for development');

-- ── crop codes ────────────────────────────────────────────────────────────
--
-- The indirection layer only. `external_scheme` stays null until D1 chooses a
-- taxonomy; filling it in now would be the hard-coding D1 exists to avoid.

insert into registry.crop_code (code, label, parent_code) values
  ('crop.maize',              'Maize',                 null),
  ('crop.maize.grain',        'Maize grain',           'crop.maize'),
  ('crop.beans',              'Beans',                 null),
  ('crop.beans.dry',          'Dry beans',             'crop.beans'),
  ('crop.coffee',             'Coffee',                null),
  ('crop.coffee.green',       'Green coffee',          'crop.coffee'),
  ('crop.coffee.kiboko',      'Kiboko (dried cherry)', 'crop.coffee'),
  ('crop.banana',             'Banana',                null),
  ('crop.banana.matooke',     'Matooke',               'crop.banana'),
  ('crop.groundnut',          'Groundnut',             null),
  ('crop.groundnut.shelled',  'Shelled groundnut',     'crop.groundnut');

-- ── unit conversions ──────────────────────────────────────────────────────

-- Definitions. These are the SI relationships and cannot be wrong.
insert into registry.unit_conversion
  (id, from_unit, to_unit, factor, commodity, region_code, region_vintage,
   valid_from, valid_to, basis, source) values
  ('019fc600-0000-7000-8000-000000000001', 'kg',    'kg', 1,       null, null, null, null, null, 'measured', 'identity'),
  ('019fc600-0000-7000-8000-000000000002', 'tonne', 'kg', 1000,    null, null, null, null, null, 'measured', 'SI definition'),
  ('019fc600-0000-7000-8000-000000000003', 'gram',  'kg', 0.001,   null, null, null, null, null, 'measured', 'SI definition');

-- A named external standard.
insert into registry.unit_conversion
  (id, from_unit, to_unit, factor, commodity, region_code, region_vintage,
   valid_from, valid_to, basis, source) values
  ('019fc600-0000-7000-8000-000000000010', 'bag', 'kg', 60, 'crop.coffee.green', null, null, null, null,
   'published_standard', 'International Coffee Organization standard green coffee bag, 60 kg');

-- Everything below is the commonly quoted trade figure and nothing more. Each
-- one is a question for the §13 field exercise, not an answer from it.
insert into registry.unit_conversion
  (id, from_unit, to_unit, factor, commodity, region_code, region_vintage,
   valid_from, valid_to, basis, source) values
  ('019fc600-0000-7000-8000-000000000020', 'bag',   'kg', 100, 'crop.maize.grain',       null, null, null, null, 'assumed_default', 'commonly quoted 100 kg trading bag; unverified'),
  ('019fc600-0000-7000-8000-000000000021', 'bag',   'kg', 100, 'crop.beans.dry',         null, null, null, null, 'assumed_default', 'commonly quoted 100 kg trading bag; unverified'),
  ('019fc600-0000-7000-8000-000000000022', 'bag',   'kg', 100, 'crop.groundnut.shelled', null, null, null, null, 'assumed_default', 'commonly quoted 100 kg trading bag; unverified'),
  ('019fc600-0000-7000-8000-000000000023', 'sack',  'kg',  50, 'crop.maize.grain',       null, null, null, null, 'assumed_default', 'half-bag sack; unverified'),
  ('019fc600-0000-7000-8000-000000000024', 'tin',   'kg',  18, 'crop.maize.grain',       null, null, null, null, 'assumed_default', 'the 20-litre debe, filled with maize grain; unverified'),
  ('019fc600-0000-7000-8000-000000000025', 'basin', 'kg',  20, 'crop.maize.grain',       null, null, null, null, 'assumed_default', 'basin size varies by trader; unverified'),
  ('019fc600-0000-7000-8000-000000000026', 'bunch', 'kg',  18, 'crop.banana.matooke',    null, null, null, null, 'assumed_default', 'matooke bunches range roughly 10-40 kg; a single figure is a poor model'),
  ('019fc600-0000-7000-8000-000000000027', 'bag',   'kg',  85, 'crop.coffee.kiboko',     null, null, null, null, 'assumed_default', 'unverified');

-- Region-specific, and more specific than the national row above: highland
-- bags are widely reported as larger. Also unverified.
insert into registry.unit_conversion
  (id, from_unit, to_unit, factor, commodity, region_code, region_vintage,
   valid_from, valid_to, basis, source) values
  ('019fc600-0000-7000-8000-000000000030', 'bag', 'kg', 120, 'crop.maize.grain',
   'UG.KAPCHORWA', '2020', null, null, 'assumed_default',
   'highland bags reported larger than the national figure; unverified');

-- ── observation types ─────────────────────────────────────────────────────
--
-- `owner` names who is accountable for the entry. What powers that carries is
-- open decision D8; this column is where the answer will attach.

insert into registry.observation_type
  (code, version, label, unit, value_kind, permitted_methods, subject_types, owner, source) values
  ('loss.declared', 1, 'Declared loss against a lot', 'kg', 'quantity',
   array['reported', 'field_instrument', 'lab_tested'], array['lot'],
   'clycites.kernel', 'spec §9.1 — a loss is an event with provenance, see docs/decisions/0011-losses-as-observations.md'),

  ('moisture.grain_pct', 1, 'Grain moisture content', 'pct', 'scalar',
   array['field_instrument', 'lab_tested'], array['lot', 'plot'],
   'clycites.kernel', 'moisture meter reading at intake'),

  ('soil.ph', 1, 'Soil pH', 'ph', 'scalar',
   array['lab_tested', 'field_instrument'], array['plot'],
   'clycites.kernel', null),

  ('pest.incidence', 1, 'Pest incidence', null, 'category',
   array['visual', 'survey', 'reported'], array['plot', 'planting'],
   'clycites.kernel', null),

  ('storage.condition', 1, 'Storage condition', null, 'category',
   array['visual', 'survey'], array['facility', 'lot'],
   'clycites.kernel', null);

-- ── grading schemes ───────────────────────────────────────────────────────
--
-- `ordinal` orders values inside one scheme. It is never compared across
-- schemes: a buyer's Grade 1 and the UNBS Grade 1 are different claims.

insert into registry.grading_scheme (scheme, label, owner, source) values
  ('unbs.maize',   'UNBS maize grain grades',  'unbs',    'scheme identifier only; the standard text is not reproduced here'),
  ('ugacof.robusta', 'Buyer robusta grades',   'ugacof',  'illustrative buyer scheme for development'),
  ('coop.local',   'Cooperative intake grades', 'coop',   'whatever the coop writes on the intake sheet');

insert into registry.grading_scheme_value (scheme, value, label, ordinal) values
  ('unbs.maize',      'grade_1',  'Grade 1',      1),
  ('unbs.maize',      'grade_2',  'Grade 2',      2),
  ('unbs.maize',      'grade_3',  'Grade 3',      3),
  ('unbs.maize',      'ungraded', 'Ungraded',     null),
  ('ugacof.robusta',  'screen_18', 'Screen 18',   1),
  ('ugacof.robusta',  'screen_15', 'Screen 15',   2),
  ('ugacof.robusta',  'ff',        'Fair average', 3),
  ('coop.local',      'clean',    'Clean',        1),
  ('coop.local',      'mixed',    'Mixed',        2),
  ('coop.local',      'wet',      'Wet',          3);
