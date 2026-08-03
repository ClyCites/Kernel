-- 0019 — same_as as a reversible assertion. Work order M3, deferring D2.
--
-- Two records name what is probably the same farmer. D2 asks what to do about
-- it. There are two shapes on offer and they are not symmetric:
--
--   merge — rewrite one party's id to the other's, or route reads through a
--           canonical id. Cheap to consume and impossible to undo. Every
--           record written after the merge inherits the decision, so if the
--           field says the two really were different people, there is no
--           state to go back to.
--   link  — assert that A and B are probably the same, with who says so, how
--           confident they are, and on what evidence. Consumers see a set and
--           the links between its members, and decide for themselves.
--
-- Linking is recoverable and merging is not, so linking is what gets built.
-- Collapsing links into merges later is a migration anyone can write. Undoing
-- a merge is archaeology.
--
-- This does NOT close D2. D2 asks what cooperatives actually want when the
-- register has the same person twice; a table that can hold either answer is
-- not the answer. It also does not touch @clycites/schema — the vendored
-- package is read-only, and this is the same "kernel-side, promotion candidate
-- for v0.3" position as `dataset` (0011) and `lawful_basis` (0013).
--
-- See docs/decisions/0026-party-links.md.

-- ── the table ─────────────────────────────────────────────────────────────
--
-- An assertion, not reference data, so it lives in `kernel` beside
-- `record_key` rather than in `registry`. It carries the two columns every
-- assertion in this system carries: `dataset`, so fabricated links can never
-- be counted against real people, and `lawful_basis`, because asserting that
-- two named individuals are the same person is processing personal data and
-- s.7 wants a ground for it.

create table kernel.party_link (
  id             uuid primary key,
  relation       text not null,
  left_party     uuid not null,
  right_party    uuid not null,
  asserted_by    uuid not null,
  asserted_at    timestamptz not null,
  confidence     numeric(4, 3) not null check (confidence > 0 and confidence <= 1),
  evidence       text not null,
  evidence_note  text null,
  dataset        text not null default 'live',
  lawful_basis   text not null,
  -- The retraction path. A withdrawn link is not deleted and not edited; the
  -- row stays and these three columns fill in, so "we thought these were the
  -- same person and stopped thinking so" is itself on the record.
  retracted_at   timestamptz null,
  retracted_by   uuid null,
  retraction_reason text null,
  recorded_at    timestamptz not null default now(),

  constraint party_link_relation_known
    check (relation in ('same_as')),
  -- Undirected. The pair is stored in a fixed order so that asserting B~A
  -- after A~B collides rather than quietly creating a second link.
  constraint party_link_ordered
    check (left_party < right_party),
  constraint party_link_distinct
    check (left_party <> right_party),
  constraint party_link_dataset_known
    check (dataset in ('live', 'seed')),
  constraint party_link_basis_known
    check (lawful_basis in (
      'consent', 'legal_authorisation', 'public_duty', 'national_security',
      'law_enforcement', 'contract_performance', 'medical', 'legal_obligation',
      'special_data_consent'
    )),
  -- What the claim rests on. `assumed` exists so that a link somebody entered
  -- on a hunch is expressible and visibly weak, rather than being dressed up
  -- as one of the others.
  constraint party_link_evidence_known
    check (evidence in (
      'national_id_match',      -- both parties carry the same NIN
      'phone_match',            -- both carry the same contact number
      'name_and_region_match',  -- the weakest thing worth recording
      'declared_by_subject',    -- the person said so
      'declared_by_organisation',
      'assumed'
    )),
  constraint party_link_retraction_complete
    check (num_nulls(retracted_at, retracted_by, retraction_reason) in (0, 3))
);

comment on table kernel.party_link is
  'Assertions that two parties are probably the same. Reads resolve these '
  'transitively and never collapse identities. Open decision D2.';

comment on column kernel.party_link.confidence is
  'Who asserted it is in asserted_by; how sure they are is here. A consumer '
  'that wants only strong links filters on both.';

-- One live link per pair per asserter. A second opinion from a different
-- party is a second row, which is the point: disagreement is data.
create unique index party_link_pair
  on kernel.party_link (relation, left_party, right_party, asserted_by)
  where retracted_at is null;

create index party_link_left  on kernel.party_link (left_party)
  where retracted_at is null;
create index party_link_right on kernel.party_link (right_party)
  where retracted_at is null;

create index party_link_non_live on kernel.party_link (dataset)
  where dataset <> 'live';

-- ── append-only ───────────────────────────────────────────────────────────
--
-- The one exception is filling in a retraction, which has to be an UPDATE
-- because the retraction is a property of the link rather than a separate
-- claim about the world. The trigger permits exactly that transition and
-- nothing else: an unretracted row may become a retracted one, and no other
-- column may move.

create or replace function kernel.party_link_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'kernel.party_link is append-only: retract the link, do not delete it'
      using errcode = 'restrict_violation';
  end if;

  if old.retracted_at is not null then
    raise exception 'party link % is already retracted', old.id
      using errcode = 'restrict_violation';
  end if;

  if (old.id, old.relation, old.left_party, old.right_party, old.asserted_by,
      old.asserted_at, old.confidence, old.evidence, old.evidence_note,
      old.dataset, old.lawful_basis, old.recorded_at)
     is distinct from
     (new.id, new.relation, new.left_party, new.right_party, new.asserted_by,
      new.asserted_at, new.confidence, new.evidence, new.evidence_note,
      new.dataset, new.lawful_basis, new.recorded_at)
  then
    raise exception 'kernel.party_link is append-only: only a retraction may be recorded'
      using errcode = 'restrict_violation';
  end if;

  if new.retracted_at is null then
    raise exception 'the only permitted update to a party link is its retraction'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger party_link_append_only
  before update or delete on kernel.party_link
  for each row execute function kernel.party_link_append_only();

grant select, insert, update on kernel.party_link to kernel_app;
revoke delete, truncate on kernel.party_link from kernel_app;
