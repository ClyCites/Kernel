-- 0015 — The weighings themselves, not a summary of them.
--
-- 0012 recorded `sample_size`, `sample_min`, `sample_max` and `sample_stddev`.
-- That was enough to tell a reader how much evidence there was and not enough
-- to let them check it. Four summary statistics cannot be recomputed into the
-- twelve numbers they came from, and who did the weighing, when, and on what
-- instrument survived only as prose in `source` — unqueryable, and lost to
-- anyone reading the factor through an API.
--
-- Work order K makes the registry publicly readable so a third party can verify
-- a weight without trusting ClyCites. That is only true if what they can read
-- is the evidence. A `basis` of `measured` that dereferences to another
-- adjective is the same act of faith the platform exists to end.
--
-- See docs/decisions/0024-registry-read-api.md.

alter table registry.unit_conversion
  add column measured_by text        null,
  add column measured_at timestamptz null,
  add column instrument  text        null;

comment on column registry.unit_conversion.measured_by is
  'Who performed the weighing. A name or role, not a party id: the person who held the scale is frequently not a party in the log.';
comment on column registry.unit_conversion.measured_at is
  'When the weighing happened, which is not when the row was written.';
comment on column registry.unit_conversion.instrument is
  'What it was weighed on. A calibrated platform scale and a trader''s beam are different claims.';

create table registry.unit_conversion_sample (
  conversion uuid           not null references registry.unit_conversion (id),
  ordinal    integer        not null check (ordinal > 0),
  weight_kg  numeric(20, 8) not null check (weight_kg > 0),
  -- Per sample, because a sample is not homogeneous. One damp bag among eleven
  -- dry ones is the observation that explains the spread.
  condition  text           null,
  created_at timestamptz    not null default now(),

  primary key (conversion, ordinal)
);

create trigger unit_conversion_sample_immutable
  before update or delete on registry.unit_conversion_sample
  for each row execute function registry.refuse_mutation();

-- A registry that misstates its own sample is worse than one that states
-- nothing, because the summary is what a reader who does not fetch the rows
-- will believe. Keep the two in agreement at write time.
create or replace function registry.check_sample_ordinal() returns trigger
language plpgsql as $$
declare
  declared integer;
begin
  select sample_size into declared
    from registry.unit_conversion where id = new.conversion;

  if declared is null then
    raise exception
      'conversion % states no sample_size, so it cannot carry sample rows',
      new.conversion
      using errcode = 'restrict_violation';
  end if;

  if new.ordinal > declared then
    raise exception
      'conversion % declares a sample of %, so ordinal % is out of range',
      new.conversion, declared, new.ordinal
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger unit_conversion_sample_within_declared_size
  before insert on registry.unit_conversion_sample
  for each row execute function registry.check_sample_ordinal();

grant select on registry.unit_conversion_sample to kernel_app;

-- ── the twelve weights behind 0014 ────────────────────────────────────────
--
-- A new row, not a backfill of ...0050. The immutability trigger refuses an
-- UPDATE here even to the owner, and it is right to: attaching provenance to a
-- row that records already cite would retroactively give those records evidence
-- they did not have when they were written. That is the exact failure the
-- `conversion_id` indirection exists to prevent (0009). So ...0050 stands as
-- the factor as first stated, and this supersedes it.
--
-- Coop A's kaveera, weighed in one store on one morning. Two of the twelve were
-- noticeably damper than the rest and are recorded as such rather than averaged
-- away: a lender who sees a 2.68 kg spread deserves to know that part of it is
-- moisture rather than bagging.

insert into registry.unit_conversion
  (id, from_unit, to_unit, factor, commodity, region_code, region_vintage,
   valid_from, valid_to, basis, source, supersedes,
   sample_size, sample_min, sample_max, sample_stddev, condition, local_label,
   measured_by, measured_at, instrument)
values
  ('019fc600-0000-7000-8000-000000000051', 'bag', 'kg', 100, 'crop.maize.grain',
   null, null, null, null, 'measured',
   'Twelve kaveera weighed at the Bukoto store. The individual weights are rows in registry.unit_conversion_sample.',
   '019fc600-0000-7000-8000-000000000050',
   12, 95.8, 104.3, 2.67650, 'dried,tight', 'kaveera',
   'Officer A-01, Bukoto Farmers Cooperative Society',
   '2026-07-14T10:00:00+03:00',
   'Calibrated platform scale, 200 kg capacity, 0.1 kg division');

insert into registry.unit_conversion_sample
  (conversion, ordinal, weight_kg, condition)
values
  ('019fc600-0000-7000-8000-000000000051',  1,  97.4, 'dried,tight'),
  ('019fc600-0000-7000-8000-000000000051',  2, 101.2, 'dried,tight'),
  ('019fc600-0000-7000-8000-000000000051',  3,  99.8, 'dried,tight'),
  ('019fc600-0000-7000-8000-000000000051',  4, 103.6, 'damp,tight'),
  ('019fc600-0000-7000-8000-000000000051',  5,  96.9, 'dried,tight'),
  ('019fc600-0000-7000-8000-000000000051',  6, 100.4, 'dried,tight'),
  ('019fc600-0000-7000-8000-000000000051',  7,  98.2, 'dried,tight'),
  ('019fc600-0000-7000-8000-000000000051',  8, 102.7, 'dried,tight'),
  ('019fc600-0000-7000-8000-000000000051',  9,  99.1, 'dried,tight'),
  ('019fc600-0000-7000-8000-000000000051', 10, 104.3, 'damp,tight'),
  ('019fc600-0000-7000-8000-000000000051', 11,  95.8, 'dried,tight'),
  ('019fc600-0000-7000-8000-000000000051', 12, 100.6, 'dried,tight');
