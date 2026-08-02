-- 0009 — The registry.
--
-- Reference data, not assertions. A conversion factor has a `source` and a
-- `basis`, not an `asserted_by`; it cannot satisfy the record envelope, so it
-- lives in its own schema rather than being forced into `facts.record` as an
-- entity type the vendored schema does not define.
--
-- Spec §3.2 calls a UnitConversion "a first-class versioned entity, not a
-- config file". The operative half of that is versioned: registry rows are
-- immutable and append-only, exactly like facts. A corrected factor is a new
-- row with a new id. If a factor could be edited in place, every historical
-- `normalized_kg` that referenced it would silently change meaning — the
-- precise failure the `conversion_id` indirection exists to prevent.
--
-- See docs/decisions/0010-registry-storage.md.

create schema if not exists registry;

-- ── immutability ──────────────────────────────────────────────────────────
--
-- `kernel_app` holds SELECT and nothing else (below), so the application
-- cannot write here at all. This trigger covers the other path: a seed
-- migration quietly restating a factor instead of superseding it.

create or replace function registry.refuse_mutation() returns trigger
language plpgsql as $$
begin
  raise exception
    'registry.% is append-only: supersede the row, do not edit it', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

-- ── unit conversions ──────────────────────────────────────────────────────
--
-- Resolved by unit + commodity + region + date, because a bag of maize in
-- Kapchorwa in 2026 is not a bag of beans in Mbale in 2024. A null commodity
-- or region means "applies unless something more specific matches".

create table registry.unit_conversion (
  id             uuid primary key,
  from_unit      text not null,
  to_unit        text not null,
  factor         numeric(20, 8) not null check (factor > 0),
  commodity      text null,
  region_code    text null,
  region_vintage text null,
  valid_from     date null,
  valid_to       date null,
  basis          text not null check (
                   basis in ('measured', 'published_standard',
                             'estimated', 'assumed_default')),
  source         text null,
  supersedes     uuid null references registry.unit_conversion (id),
  created_at     timestamptz not null default now(),

  constraint unit_conversion_commodity_shape
    check (commodity is null or commodity ~ '^crop\.[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  -- A region code without its boundary vintage is ambiguous across time (D6).
  constraint unit_conversion_region_needs_vintage
    check ((region_code is null) = (region_vintage is null)),
  constraint unit_conversion_region_vintage_shape
    check (region_vintage is null or region_vintage ~ '^\d{4}$'),
  constraint unit_conversion_window_ordered
    check (valid_from is null or valid_to is null or valid_to >= valid_from)
);

create index unit_conversion_lookup
  on registry.unit_conversion (from_unit, to_unit, commodity, region_code);

create trigger unit_conversion_immutable
  before update or delete on registry.unit_conversion
  for each row execute function registry.refuse_mutation();

-- ── observation types ─────────────────────────────────────────────────────
--
-- `@clycites/schema` treats `observation_type` as a namespaced string on
-- purpose. Which strings are legal, what unit they carry and which methods may
-- produce them is a kernel concern, recorded here.
--
-- `owner` is the named party accountable for the entry. Open decision D8 is
-- what powers that ownership carries; this column records the fact so the
-- answer has somewhere to land.

create table registry.observation_type (
  code              text not null,
  version           integer not null check (version > 0),
  label             text not null,
  unit              text null,
  value_kind        text not null,
  permitted_methods text[] not null check (cardinality(permitted_methods) > 0),
  subject_types     text[] not null check (cardinality(subject_types) > 0),
  owner             text not null,
  source            text null,
  created_at        timestamptz not null default now(),

  primary key (code, version),
  constraint observation_type_namespaced
    check (code ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$')
);

create trigger observation_type_immutable
  before update or delete on registry.observation_type
  for each row execute function registry.refuse_mutation();

-- ── crop codes ────────────────────────────────────────────────────────────
--
-- The indirection layer, not a taxonomy. Open decision D1 has not chosen an
-- underlying standard, so `external_scheme` / `external_code` are the hooks
-- that will carry the mapping once it does. Nothing here hard-codes one.

create table registry.crop_code (
  code            text primary key
                    check (code ~ '^crop\.[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  label           text not null,
  parent_code     text null references registry.crop_code (code),
  external_scheme text null,
  external_code   text null,
  created_at      timestamptz not null default now(),

  constraint crop_code_external_pairs
    check ((external_scheme is null) = (external_code is null))
);

create trigger crop_code_immutable
  before update or delete on registry.crop_code
  for each row execute function registry.refuse_mutation();

-- ── admin regions ─────────────────────────────────────────────────────────
--
-- Keyed by (code, vintage). Uganda's districts have subdivided repeatedly, so
-- a bare district code is ambiguous across time and historical geography
-- breaks without the vintage (D6).
--
-- How a 2014 district maps onto its 2020 successors is the unresolved half of
-- D6 and is deliberately absent: a succession table would encode an answer.

create table registry.admin_region (
  code           text not null,
  vintage        text not null check (vintage ~ '^\d{4}$'),
  name           text not null,
  level          text not null,
  parent_code    text null,
  parent_vintage text null,
  source         text null,
  created_at     timestamptz not null default now(),

  primary key (code, vintage),
  constraint admin_region_parent_pairs
    check ((parent_code is null) = (parent_vintage is null)),
  foreign key (parent_code, parent_vintage)
    references registry.admin_region (code, vintage)
);

create trigger admin_region_immutable
  before update or delete on registry.admin_region
  for each row execute function registry.refuse_mutation();

-- ── grading schemes ───────────────────────────────────────────────────────
--
-- Stored opaquely. `ordinal` orders values within one scheme and carries no
-- meaning across schemes: UNBS Grade 1 and a buyer's Grade 1 are not the same
-- claim and the kernel never treats them as comparable.

create table registry.grading_scheme (
  scheme     text primary key,
  label      text not null,
  owner      text not null,
  source     text null,
  created_at timestamptz not null default now()
);

create table registry.grading_scheme_value (
  scheme     text not null references registry.grading_scheme (scheme),
  value      text not null,
  label      text null,
  ordinal    integer null,
  created_at timestamptz not null default now(),

  primary key (scheme, value)
);

create trigger grading_scheme_immutable
  before update or delete on registry.grading_scheme
  for each row execute function registry.refuse_mutation();

create trigger grading_scheme_value_immutable
  before update or delete on registry.grading_scheme_value
  for each row execute function registry.refuse_mutation();

-- ── grants ────────────────────────────────────────────────────────────────
--
-- Read-only for the application. Seeding is a migrator operation; an
-- operational write path that does not need a deploy is future work.

grant usage on schema registry to kernel_app;

grant select on registry.unit_conversion      to kernel_app;
grant select on registry.observation_type     to kernel_app;
grant select on registry.crop_code            to kernel_app;
grant select on registry.admin_region         to kernel_app;
grant select on registry.grading_scheme       to kernel_app;
grant select on registry.grading_scheme_value to kernel_app;

revoke insert, update, delete, truncate on registry.unit_conversion      from kernel_app;
revoke insert, update, delete, truncate on registry.observation_type     from kernel_app;
revoke insert, update, delete, truncate on registry.crop_code            from kernel_app;
revoke insert, update, delete, truncate on registry.admin_region         from kernel_app;
revoke insert, update, delete, truncate on registry.grading_scheme       from kernel_app;
revoke insert, update, delete, truncate on registry.grading_scheme_value from kernel_app;

revoke create on schema registry from kernel_app;
revoke all    on schema registry from public;
