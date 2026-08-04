-- Media (work order H).
--
-- Bytes live in object storage. What lives here is everything the kernel needs
-- to decide whether a caller may see those bytes, plus enough of an inventory
-- that a restore can prove the objects came back too. See
-- docs/decisions/0037-p5-media.md.
--
-- Three tables:
--
--   media_object     one row per distinct stored object, keyed by the hash of
--                    the bytes as stored. Content-addressed, so this table is
--                    the deduplication.
--   media_reference  which records name which object. This is what the read
--                    guard runs against: you may fetch bytes if you may read a
--                    record that cites them. Without it, a presigned URL would
--                    be an access path that never passes through consent.
--   upload_session   resumable upload state, and the chunks received so far.
--
-- Note what is *not* in the storage key: no party id, no date, no record id,
-- no original filename. A key appears in proxy logs, in browser history, in
-- crash reports and in screenshots. `farmers/<id>/delivery-2026-05-07.jpg`
-- discloses a farmer and a delivery date to everyone who sees any of those.
-- `live/sha256/ab/cd/abcd...` discloses that an object exists.

create table kernel.media_object (
  -- The hash of the bytes as stored, after metadata stripping. This is the
  -- value that goes in MediaRef.content_hash and the value that gets anchored,
  -- so it must be the hash of what a verifier can actually fetch.
  content_hash       text        not null,
  dataset            text        not null,

  -- The hash of the bytes as received, which is what the client claimed and
  -- what was checked on arrival. Equal to content_hash when nothing was
  -- stripped. Kept because it is the only evidence that the upload arrived
  -- intact: after stripping, the received bytes no longer exist to re-check.
  received_hash      text        not null,

  mime_type          text        not null,
  byte_size          bigint      not null,
  received_size      bigint      not null,
  storage_ref        text        not null,
  metadata_stripped  boolean     not null,
  first_seen_at      timestamptz not null default now(),
  first_seen_by      uuid        not null,

  constraint media_object_pk primary key (content_hash, dataset),
  constraint media_object_hash_is_sha256
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint media_object_received_hash_is_sha256
    check (received_hash ~ '^[0-9a-f]{64}$'),
  constraint media_object_dataset_known
    check (dataset in ('live', 'seed')),
  constraint media_object_size_positive
    check (byte_size > 0 and received_size > 0),
  -- Stripping only ever removes bytes. A stored object larger than what
  -- arrived means the strip pass added something, which is a bug worth
  -- refusing the write over.
  constraint media_object_strip_only_removes
    check (byte_size <= received_size),
  constraint media_object_ref_unique unique (storage_ref)
);

comment on table kernel.media_object is
  'One row per distinct stored object. Content-addressed: the primary key is '
  'the hash of the stored bytes, so uploading the same photograph twice '
  'stores it once.';

-- ── references ──────────────────────────────────────────────────────────────
--
-- Populated at ingest from every MediaRef found in a record body. A record
-- may cite several objects and an object may be cited by several records —
-- the same photograph can be evidence in a dispute and in an inspection.

create table kernel.media_reference (
  content_hash  text        not null,
  record_id     uuid        not null,
  record_class  text        not null,
  dataset       text        not null,
  cited_at      timestamptz not null default now(),

  constraint media_reference_pk primary key (content_hash, record_id),
  constraint media_reference_hash_is_sha256
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint media_reference_dataset_known
    check (dataset in ('live', 'seed')),
  constraint media_reference_class_known
    check (record_class in ('observation', 'inference'))
);

create index media_reference_by_record
  on kernel.media_reference (record_id);

comment on table kernel.media_reference is
  'Which records cite which objects. The bytes are readable only through a '
  'record the caller may read, so this is the join the consent check needs.';

-- ── upload sessions ─────────────────────────────────────────────────────────
--
-- A 4MB photograph on a metered rural network fails partway through, often.
-- Non-resumable means the client restarts from zero, fails again, and the
-- record never syncs — silently, because from the client's point of view it
-- was submitted.

create table kernel.upload_session (
  id              uuid        primary key,
  declared_hash   text        not null,
  declared_mime   text        not null,
  declared_size   bigint      not null,
  received_size   bigint      not null default 0,
  state           text        not null default 'open',
  -- Set only when state = 'rejected'. A rejected session keeps its reason so
  -- a field client can show why rather than retrying forever.
  rejection       text        null,
  -- Set only when state = 'complete'.
  content_hash    text        null,
  started_by      uuid        not null,
  dataset         text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz not null,

  constraint upload_session_declared_hash_is_sha256
    check (declared_hash ~ '^[0-9a-f]{64}$'),
  constraint upload_session_state_known
    check (state in ('open', 'complete', 'rejected')),
  constraint upload_session_dataset_known
    check (dataset in ('live', 'seed')),
  constraint upload_session_size_positive
    check (declared_size > 0),
  constraint upload_session_offset_within_length
    check (received_size >= 0 and received_size <= declared_size),
  constraint upload_session_rejection_iff_rejected
    check ((state = 'rejected') = (rejection is not null)),
  constraint upload_session_hash_iff_complete
    check ((state = 'complete') = (content_hash is not null))
);

create index upload_session_expiring
  on kernel.upload_session (expires_at)
  where state = 'open';

create table kernel.upload_chunk (
  session_id   uuid        not null
    references kernel.upload_session (id) on delete cascade,
  chunk_offset bigint      not null,
  byte_length  bigint      not null,
  storage_ref  text        not null,
  received_at  timestamptz not null default now(),

  constraint upload_chunk_pk primary key (session_id, chunk_offset),
  constraint upload_chunk_offset_not_negative check (chunk_offset >= 0),
  constraint upload_chunk_length_positive check (byte_length > 0)
);

comment on table kernel.upload_chunk is
  'Parts of an in-flight upload, staged in object storage. Assembled, hashed '
  'and stripped once the last byte arrives; the staging objects are then '
  'removed. Postgres holds the offsets because that is the state a resume '
  'has to be able to read back.';

-- ── grants ──────────────────────────────────────────────────────────────────
--
-- These four tables are the exception to append-only, and deliberately so.
-- They are not the record. An upload session is working state — an offset that
-- advances as bytes arrive — and modelling a partially-received file as an
-- append-only log of offset changes would buy nothing and cost a join on every
-- PATCH. The append-only guarantee is about assertions: what somebody claimed
-- about the world. Nobody asserted anything by uploading half a photograph.
--
-- media_object and media_reference are narrower still: insert and select, no
-- update, no delete. An object, once stored, is exactly as immutable as a
-- fact, because its identity *is* its content — a changed object is a
-- different row.

grant select, insert on kernel.media_object to kernel_app;
grant select, insert on kernel.media_reference to kernel_app;
grant select, insert, update, delete on kernel.upload_session to kernel_app;
grant select, insert, delete on kernel.upload_chunk to kernel_app;

-- The training role gets nothing here. Photographs of a farmer's homestead are
-- exactly the sort of thing that must not fall into a training corpus by
-- accident, and the guard in 0028 works by the role holding no grant at all.
revoke all on kernel.media_object from kernel_training;
revoke all on kernel.media_reference from kernel_training;
revoke all on kernel.upload_session from kernel_training;
revoke all on kernel.upload_chunk from kernel_training;

-- ── append-only, where it applies ───────────────────────────────────────────

create or replace function kernel.media_object_append_only()
  returns trigger language plpgsql as $$
begin
  raise exception 'kernel.media_object is append-only (attempted %)', tg_op
    using errcode = '42501';
end
$$;

create trigger media_object_no_change
  before update or delete on kernel.media_object
  for each row execute function kernel.media_object_append_only();

create or replace function kernel.media_reference_append_only()
  returns trigger language plpgsql as $$
begin
  raise exception 'kernel.media_reference is append-only (attempted %)', tg_op
    using errcode = '42501';
end
$$;

create trigger media_reference_no_change
  before update or delete on kernel.media_reference
  for each row execute function kernel.media_reference_append_only();

-- ── the inventory a restore is checked against ──────────────────────────────
--
-- scripts/backup.sh fingerprints Postgres. Once objects exist, that is half a
-- backup: a restore that recovers every row and no objects leaves every
-- MediaRef pointing at nothing, and looks completely healthy while doing it.
-- This view is what the manifest reads, and what a restore compares the
-- surviving bucket against.

create or replace view kernel.object_inventory as
  select
    o.dataset,
    count(*)                          as object_count,
    coalesce(sum(o.byte_size), 0)     as byte_total,
    -- Over the keys, in a fixed order, exactly as the table fingerprints in
    -- the manifest are. Order by content_hash and not by insertion: two
    -- correct replicas must agree regardless of the order bytes arrived in.
    coalesce(
      md5(string_agg(o.content_hash, '|' order by o.content_hash)),
      'empty')                        as digest
  from kernel.media_object o
  group by o.dataset;

grant select on kernel.object_inventory to kernel_app;

comment on view kernel.object_inventory is
  'Object count and hash inventory per dataset. Read by scripts/backup.sh '
  'into the manifest and re-read by scripts/restore.sh, so that a restore '
  'which recovers the database but not the bucket fails instead of passing.';

-- ── the audit log learns three verbs ────────────────────────────────────────
--
-- The action set is closed (0017) so that a query answering a data subject
-- cannot miss entries filed under a spelling nobody remembered. Media needs
-- its own three rather than borrowing `record.read`, because releasing the
-- bytes of a photograph is a materially different act from returning the row
-- that cites it, and an operator reading the log should be able to tell them
-- apart without inspecting the descriptor.

alter table audit.entry drop constraint entry_action_known;
alter table audit.entry add constraint entry_action_known check (action in (
  'record.read',
  'record.write',
  'consent.denied',
  'write.refused',
  'schema.ddl',
  'media.read',       -- a download url was issued for stored bytes
  'media.write',      -- bytes were accepted and stored
  'media.refused'     -- an upload was refused
));

-- ── and the two answers that must not miss it ───────────────────────────────
--
-- s.24(1)(c) asks who data was disclosed to; s.16(4) asks who to notify when a
-- record is corrected. A photograph of a farmer's homestead released to a
-- lender is a disclosure by any reading, so leaving `media.read` out of these
-- would mean the most sensitive artifacts in the system were the ones absent
-- from the subject's own disclosure list. Both functions are replaced rather
-- than extended in place, because their bodies are the legal answer and are
-- meant to be read whole.

create or replace function audit.disclosures_to(p_subject uuid, p_dataset text)
  returns table (
    occurred_at  timestamptz,
    actor        uuid,
    purpose      text,
    access       text,
    record_types text[],
    records      uuid[]
  )
language sql
stable
security definer
set search_path = ''
as $$
  select e.occurred_at,
         e.actor,
         e.purpose,
         e.detail ->> 'access' as access,
         e.record_types,
         e.records
    from audit.entry e
   where p_subject = any(e.subjects)
     and e.dataset = p_dataset
     and e.action in ('record.read', 'media.read')
     and e.outcome = 'allowed'
     and e.actor is distinct from p_subject
   order by e.occurred_at desc
$$;

create or replace function audit.recipients_of(
  p_record uuid, p_dataset text, p_exclude uuid[]
)
  returns table (
    recipient   uuid,
    first_seen  timestamptz,
    last_seen   timestamptz,
    disclosures bigint
  )
language sql
stable
security definer
set search_path = ''
as $$
  select e.actor as recipient,
         min(e.occurred_at) as first_seen,
         max(e.occurred_at) as last_seen,
         count(*) as disclosures
    from audit.entry e
   where p_record = any(e.records)
     and e.dataset = p_dataset
     and e.action in ('record.read', 'media.read')
     and e.outcome = 'allowed'
     and e.actor is not null
     and not (e.actor = any(p_exclude))
   group by e.actor
$$;
