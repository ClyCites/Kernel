-- 0018 — Season calendar. Work order M4, deferring open decision D5.
--
-- `SeasonLabel` is an opaque string in `@clycites/schema` and stays that way.
-- What "2026A" covers is a regional fact with a vintage, not a schema fact:
-- the same label means different dates in a bimodal district and in Karamoja,
-- and it means different dates in different years. Resolving it through a
-- registry table is what makes the field's eventual answer an INSERT instead
-- of a migration and a redeploy.
--
-- This does NOT close D5. D5 asks whose calendar wins when a cooperative's
-- working definition of a season differs from the national one. A table that
-- can hold both, keyed by region, is the shape that keeps the question
-- answerable; it is not the answer.
--
-- Every row carries provenance and a citation, and rows without one are
-- refused by constraint rather than by review. See docs/data-sources.md.

-- ── the table ─────────────────────────────────────────────────────────────
--
-- Keyed by (region, vintage, label). The region vintage is the admin-boundary
-- vintage, exactly as elsewhere: a season scoped to a district code without
-- one is ambiguous the moment the district subdivides.
--
-- `basis` is the same distinction the rest of the kernel draws everywhere:
-- `published` means somebody with authority wrote it down and the citation is
-- in `source`; `observed` would mean it was derived from records in this log.
-- Nothing here is `observed` yet, and inventing one would be the fabrication
-- this table exists to prevent.

create table registry.season_calendar (
  region_code    text not null,
  region_vintage text not null check (region_vintage ~ '^\d{4}$'),
  label          text not null,
  starts_on      date not null,
  ends_on        date not null,
  basis          text not null check (basis in ('published', 'observed')),
  source         text not null,
  note           text null,
  created_at     timestamptz not null default now(),

  primary key (region_code, region_vintage, label),

  constraint season_calendar_ordered
    check (ends_on >= starts_on),
  -- A season nobody can trace back is indistinguishable from one somebody
  -- invented, so the citation is not nullable and not allowed to be blank.
  constraint season_calendar_cited
    check (length(btrim(source)) > 0),
  foreign key (region_code, region_vintage)
    references registry.admin_region (code, vintage)
);

comment on table registry.season_calendar is
  'What a SeasonLabel covers, per region. Open decision D5 is whose calendar '
  'wins when a cooperative disagrees; this table can hold both answers.';

comment on column registry.season_calendar.basis is
  'published: a citable authority said so. observed: derived from records in '
  'this log. Nothing is observed yet.';

create trigger season_calendar_immutable
  before update or delete on registry.season_calendar
  for each row execute function registry.refuse_mutation();

grant select on registry.season_calendar to kernel_app;
revoke insert, update, delete, truncate on registry.season_calendar from kernel_app;

-- ── what can be cited ─────────────────────────────────────────────────────
--
-- FAO GIEWS Uganda Country Brief, reference date 8 May 2026. In the bimodal
-- rainfall areas that cover most of the country, first-season crops "were
-- planted in February and March 2026, and will be harvested in June and July".
-- In the unimodal agropastoral Karamoja Region the rainy season "normally
-- spans from April to August".
--
-- Note what is NOT here. That issue of the brief says nothing about the second
-- season, so there is no 2026B row and a read for one returns nothing rather
-- than a plausible guess. The gap is the point: it is visibly missing, and
-- filling it is one INSERT with a citation.
--
-- Note also what these dates are. The brief describes planting and harvesting
-- windows, not a season boundary. `starts_on` is taken as the start of the
-- planting window and `ends_on` as the end of the harvest window, which is an
-- interpretation, recorded in `note` rather than hidden.
--
-- And note the scope. GIEWS makes one national statement about bimodal areas,
-- so this is one national row. Copying it onto each of the four district codes
-- the seed uses would manufacture a precision the source does not have.
-- Karamoja is the stated exception and has no row, because no Karamoja district
-- code is in `registry.admin_region` to hang one on.

insert into registry.season_calendar
  (region_code, region_vintage, label, starts_on, ends_on, basis, source, note)
values
  ('UG', '2020', '2026A', '2026-02-01', '2026-07-31', 'published',
   'FAO GIEWS Uganda Country Brief, reference date 2026-05-08. '
   'https://www.fao.org/giews/countrybrief/country.jsp?code=UGA',
   'Bimodal first season: planted February and March 2026, harvested June '
   'and July. Dates are the planting and harvest windows, not a stated '
   'season boundary. Does not apply to the unimodal Karamoja Region, whose '
   'rainy season normally spans April to August.');
