-- 0031 — The three SI conversions, corrected forward.
--
-- FINDING from work order P1: `019fc600-…0001` (kg→kg), `…0002` (tonne→kg) and
-- `…0003` (gram→kg) all carry `basis = 'measured'`. Nobody weighed anything.
-- Nobody could have: these are definitions, not observations. The rows claimed
-- the strongest provenance the registry offers on the flimsiest possible
-- grounds, and `measured` is exactly the label a reader trusts most.
--
-- They are also the reason `unit_conversion_measured_shows_sample` carries a
-- hardcoded three-id exemption. A constraint with a list of rows it does not
-- apply to is a constraint telling you those rows are wrong.
--
-- Correct forward, do not repair. The registry refuses UPDATE and DELETE to
-- everyone including the owner — that is 0009 and 0020 working as designed, not
-- an obstacle to route around. The old rows stay, wrong and visible, with new
-- rows pointing back at them. Any record that cited a superseded factor still
-- resolves to exactly the number it was written against, which is the entire
-- point of never editing in place.

insert into registry.unit_conversion
  (id, from_unit, to_unit, factor, commodity, region_code, region_vintage,
   valid_from, valid_to, basis, source, supersedes)
values
  -- kg→kg. Not a standard so much as an identity, and `published_standard` is
  -- the closest honest label the current enum offers. Schema v0.3 adds
  -- `definitional`, which is what this row actually wants; see 0039.
  ('019fc600-0000-7000-8000-000000000101', 'kg', 'kg', 1, null,
   null, null, null, null, 'published_standard',
   'SI — BIPM SI Brochure, 9th edition (2019). The kilogram is the SI base unit of mass; kg→kg is the identity, established by definition and not by weighing.',
   '019fc600-0000-7000-8000-000000000001'),

  ('019fc600-0000-7000-8000-000000000102', 'tonne', 'kg', 1000, null,
   null, null, null, null, 'published_standard',
   'SI — BIPM SI Brochure, 9th edition (2019), Table 8. The tonne is a non-SI unit accepted for use with the SI, defined as exactly 10^3 kg.',
   '019fc600-0000-7000-8000-000000000002'),

  ('019fc600-0000-7000-8000-000000000103', 'gram', 'kg', 0.001, null,
   null, null, null, null, 'published_standard',
   'SI — BIPM SI Brochure, 9th edition (2019), §3.1. The gram is 10^-3 kg by the SI prefix system.',
   '019fc600-0000-7000-8000-000000000003');

-- The exemption in `unit_conversion_measured_shows_sample` stays, and must.
-- It is what lets the three original rows continue to exist unedited. What it
-- means has changed, though: it is no longer "these three are allowed to claim
-- measurement without a sample", it is "these three historical rows made that
-- claim before it was corrected". Recording that here because the constraint
-- text cannot say it.
comment on constraint unit_conversion_measured_shows_sample
  on registry.unit_conversion is
  'The three exempted ids are the original SI rows, superseded by 0031. The exemption keeps them readable, not defensible.';
