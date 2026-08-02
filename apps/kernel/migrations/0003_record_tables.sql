-- 0003 — Record tables.
--
-- The envelope (spec §4) is stored as real columns because the kernel queries,
-- indexes, and enforces invariants on it. The entity body is `jsonb` because
-- the kernel deliberately does not know what is in it — @clycites/schema does,
-- and it is the only thing permitted to validate it (brief §7).
--
-- Both tables are partitioned by month on `recorded_at`. Partition maintenance
-- lives in 0004.

-- ── The global id registry ──────────────────────────────────────────────
--
-- Ingest is idempotent on the client-generated record id (brief §4 invariant 5).
-- A partitioned table cannot carry a unique constraint on `id` alone — the
-- partition key must be part of every unique index — so uniqueness is held here
-- instead, in one unpartitioned table. `insert ... on conflict (id) do nothing`
-- makes replay detection atomic rather than a check-then-insert race.
--
-- The registry spans both namespaces so that an id means exactly one record
-- anywhere in the kernel. It is not a read path: reads go to the record tables,
-- and this table never leaks an inference into a fact query.
create table kernel.record_key (
  id           uuid        primary key,
  record_class text        not null,
  type         text        not null,
  recorded_at  timestamptz not null,

  constraint record_key_class_known
    check (record_class in ('observation', 'inference'))
);

comment on table kernel.record_key is
  'Global uniqueness for record ids. Makes ingest idempotent on replay.';

-- ── Observations ────────────────────────────────────────────────────────
create table facts.record (
  id                    uuid        not null,
  type                  text        not null,
  record_class          text        not null,
  schema_version        text        not null,
  occurred_at           timestamptz not null,
  occurred_at_precision text        not null,
  recorded_at           timestamptz not null,
  asserted_by           uuid        not null,
  authenticated_as      uuid,
  on_behalf_of          uuid,
  delegation            uuid,
  device_id             text,
  supersedes            uuid,

  -- The entity-specific fields, exactly as @clycites/schema validated them.
  body                  jsonb       not null,

  -- Spec §2.5, §11: stored and returned verbatim, never read by the kernel.
  ext                   jsonb       not null default '{}'::jsonb,

  -- Kernel-derived, brief §4 invariant 4. Held outside `body` on purpose: the
  -- kernel never edits a record it was given. See
  -- docs/decisions/0002-derived-fields.md.
  quality_flags         text[]      not null default '{}',

  primary key (id, recorded_at),

  -- Invariant 2: this namespace holds observations and nothing else.
  constraint facts_record_class_is_observation
    check (record_class = 'observation'),

  -- Invariant 3: acting for another party requires a delegation. Spec §4.
  constraint facts_on_behalf_of_requires_delegation
    check (on_behalf_of is null or delegation is not null),

  -- Spec §8 rule 3: chains are permitted, cycles are not. This catches the
  -- degenerate one-record cycle; longer cycles are checked at ingest.
  constraint facts_no_self_supersession
    check (supersedes is null or supersedes <> id),

  constraint facts_occurred_at_precision_known
    check (occurred_at_precision in ('instant', 'day', 'week', 'month', 'season'))
) partition by range (recorded_at);

comment on table facts.record is
  'The append-only fact log. INSERT and SELECT only — see 0006_grants.sql.';
comment on column facts.record.quality_flags is
  'Kernel-derived quality signals. Records are flagged, never rejected (spec §1 P6).';

-- ── Inferences ──────────────────────────────────────────────────────────
--
-- Structurally identical, deliberately separate. Spec §6.
create table inference.record (
  id                    uuid        not null,
  type                  text        not null,
  record_class          text        not null,
  schema_version        text        not null,
  occurred_at           timestamptz not null,
  occurred_at_precision text        not null,
  recorded_at           timestamptz not null,
  asserted_by           uuid        not null,
  authenticated_as      uuid,
  on_behalf_of          uuid,
  delegation            uuid,
  device_id             text,
  supersedes            uuid,
  body                  jsonb       not null,
  ext                   jsonb       not null default '{}'::jsonb,
  quality_flags         text[]      not null default '{}',

  primary key (id, recorded_at),

  constraint inference_record_class_is_inference
    check (record_class = 'inference'),
  constraint inference_on_behalf_of_requires_delegation
    check (on_behalf_of is null or delegation is not null),
  constraint inference_no_self_supersession
    check (supersedes is null or supersedes <> id),
  constraint inference_occurred_at_precision_known
    check (occurred_at_precision in ('instant', 'day', 'week', 'month', 'season'))
) partition by range (recorded_at);

comment on table inference.record is
  'Model outputs (spec §6). Excluded from every default read.';
