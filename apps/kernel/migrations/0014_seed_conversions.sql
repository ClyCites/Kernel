-- 0014 — The one registry row the adversarial seed cites and 0010 could not carry.
--
-- Work order D2 says every record goes through the public API. This is not a
-- record. `registry.unit_conversion` is reference data with no write endpoint
-- and no dataset column — it is administered, not asserted — and migration 0010
-- is the precedent for shipping it this way.
--
-- There is deliberately no beans row. Work order D4 puts coop D on a container
-- the registry has never heard of — a basket — which is the only way
-- `conversion_unresolved` becomes reproducible from fixtures rather than
-- asserted in a unit test.

-- Coop A's factor: the one the §13 field exercise is supposed to produce. Twelve
-- kaveera weighed on one morning at one store. The twelve weights live in
-- `apps/kernel/src/seed/conversions.ts` and the seed test recomputes these four
-- figures from them, so the row and the weights cannot drift apart.
--
-- FINDING: 0012 stores summary statistics. There is no column for the
-- individual weights, for who weighed them, when, or on what instrument —
-- `source` carries that as prose, which is not queryable. Recorded, not fixed
-- here: adding columns is a registry change, not a seed task.
insert into registry.unit_conversion
  (id, from_unit, to_unit, factor, commodity, region_code, region_vintage,
   valid_from, valid_to, basis, source,
   sample_size, sample_min, sample_max, sample_stddev, condition, local_label)
values
  ('019fc600-0000-7000-8000-000000000050', 'bag', 'kg', 100, 'crop.maize.grain',
   null, null, null, null, 'measured',
   'Coop A store, 12 kaveera weighed 2026-07-14 by officer A-01 on a calibrated platform scale',
   12, 95.8, 104.3, 2.67650, 'dried,tight', 'kaveera');
