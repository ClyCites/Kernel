-- 0012 — What a measured conversion actually measured.
--
-- `basis = 'measured'` currently claims a factor was established by weighing
-- and says nothing about the weighing. Twelve bags in one store on one morning
-- and four hundred bags across a district over a season are the same value in
-- this column, and the §13 field exercise will produce the first of those. A
-- lender told "measured" deserves to know which.
--
-- `condition` and `local_label` exist because the field question is not only
-- "how heavy is a bag" but "which bag". A kaveera packed tight and dried is not
-- the same container as the one the trader means, and recording the local word
-- is how a later reader can tell whether two factors describe one thing.
--
-- See docs/decisions/0018-conversion-provenance.md.

alter table registry.unit_conversion
  add column sample_size    integer        null,
  add column sample_min     numeric(20, 8) null,
  add column sample_max     numeric(20, 8) null,
  add column sample_stddev  numeric(20, 8) null,
  add column condition      text           null,
  add column local_label    text           null;

alter table registry.unit_conversion
  add constraint unit_conversion_sample_size_positive
    check (sample_size is null or sample_size > 0);

alter table registry.unit_conversion
  add constraint unit_conversion_sample_ordered
    check (sample_min is null or sample_max is null or sample_max >= sample_min);

alter table registry.unit_conversion
  add constraint unit_conversion_sample_dispersion_non_negative
    check (sample_stddev is null or sample_stddev >= 0);

-- NOT VALID, and deliberately so. The three rows already carrying 'measured'
-- are the SI identities — kg to kg, tonne to kg, gram to kg — which measured
-- nothing and cannot honestly be given a sample size.
--
-- FINDING: `ConversionBasis` conflates "this is a definition" with "we weighed
-- a sample". A fifth value would separate them, but the enum lives in
-- @clycites/schema, which is read-only. Until v0.3 can carry `definitional`,
-- the definitions stay grandfathered here and every new measured factor must
-- show its work.
alter table registry.unit_conversion
  add constraint unit_conversion_measured_shows_sample
    check (basis <> 'measured' or sample_size is not null) not valid;

comment on column registry.unit_conversion.sample_size is
  'How many containers were weighed. Required for new measured factors.';
comment on column registry.unit_conversion.condition is
  'The state the commodity was in when weighed, e.g. dried,tight.';
comment on column registry.unit_conversion.local_label is
  'What the container is called where it was weighed, e.g. kaveera.';
