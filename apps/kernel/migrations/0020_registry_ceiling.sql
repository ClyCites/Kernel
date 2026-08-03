-- 0020 — The observation vocabulary is not a place to be creative. Work order M6.
--
-- Every `observation_type` invented at a desk is one somebody has to deprecate
-- later, and a vocabulary cannot be deprecated cheaply: records citing a code
-- are permanent, so a bad code is permanent too. The pressure in this
-- migration is deliberate. Adding a type should cost a conversation.
--
-- Three rules, enforced by the database rather than by review:
--
--   1. Every entry names an owner.
--   2. Every entry carries a citation — who asked for it, or what standard it
--      comes from. "Somebody thought it might be useful" is not one.
--   3. The vocabulary stays under a ceiling, and raising the ceiling is its
--      own migration with its own justification.
--
-- Open decision D8 is what powers ownership carries. This does not answer
-- that; it makes the vocabulary small enough that the answer still matters.

-- ── an owner ──────────────────────────────────────────────────────────────
--
-- Valid immediately: every existing row names one.

alter table registry.observation_type
  add constraint observation_type_owner_named
    check (length(btrim(owner)) > 0);

-- ── a citation ────────────────────────────────────────────────────────────
--
-- NOT VALID, for the same reason 0013's lawful_basis constraint is. Three rows
-- seeded in 0010 have no source:
--
--   soil.ph, pest.incidence, storage.condition
--
-- They are exactly the entries this rule exists to prevent — plausible,
-- unused, and registered because somebody could imagine wanting them. There is
-- no honest citation to backfill, and inventing one would be worse than the
-- gap. The registry is append-only and its trigger refuses DELETE, so they
-- cannot be withdrawn either; they stay, uncited and visible, and
-- `test/invariants/registry.test.ts` names all three so that the day one
-- acquires a real citation is a deliberate edit.
--
-- Every entry added from now on must be cited.

alter table registry.observation_type
  add constraint observation_type_cited
    check (source is not null and length(btrim(source)) > 0) not valid;

comment on column registry.observation_type.source is
  'Who asked for this type, or which standard it comes from. Required for '
  'every entry added after migration 0020.';

-- ── a ceiling ─────────────────────────────────────────────────────────────
--
-- Twelve. Five are in use, so there is room for the field to ask for a handful
-- without a migration argument, and the tenth request is a conversation about
-- whether the vocabulary is doing what it is for.
--
-- A statement trigger rather than a constraint, because a table-wide count is
-- not something CHECK can express. Raising the ceiling means editing this
-- function in a new migration, which is the point: it is not a config value
-- and it is not a limit somebody can nudge.

create or replace function registry.observation_type_ceiling() returns trigger
language plpgsql as $$
declare
  ceiling constant integer := 12;
  present integer;
begin
  select count(distinct code) into present from registry.observation_type;

  if present > ceiling then
    raise exception
      'the observation vocabulary is capped at % types and this would make %',
      ceiling, present
      using errcode = 'restrict_violation',
            hint = 'Every type invented at a desk is one you will later '
                   'deprecate, and records citing a code are permanent. '
                   'Raising the ceiling is its own migration. See '
                   'docs/decisions/0028-registry-ceiling.md.';
  end if;

  return null;
end;
$$;

create trigger observation_type_capped
  after insert on registry.observation_type
  for each statement execute function registry.observation_type_ceiling();
