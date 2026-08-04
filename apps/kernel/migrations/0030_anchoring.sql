-- Anchoring (work order I).
--
-- One HCS message a day carrying one Merkle root over that day's live
-- records. See docs/decisions/0038-p6-anchoring.md.
--
-- Two tables:
--
--   anchor_batch  one row per dataset per day. Holds the root, the count, and
--                 the receipt once the network has agreed on it.
--   anchor_leaf   one row per anchored record: its salt, its digest, its leaf
--                 hash and its position in the tree. This is what a proof is
--                 built from, and it is why the proof can be reconstructed
--                 years later without re-reading the records.
--
-- The salt lives here rather than on the record because it is not a fact about
-- the world — it is a defence against grinding a low-entropy leaf, and it is
-- generated once, at anchoring time, for exactly the records being anchored.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The guard.
--
-- Anchoring seed data would publish fabricated farmer records to a public
-- ledger, irreversibly. It is the one failure in this system that cannot be
-- undone: there is no delete on a consensus service, no correction, no
-- retraction. Every other mistake here has a remedy.
--
-- So the constraint is stated three times, on purpose. A CHECK on each table,
-- and a trigger that reads kernel.record_key and refuses a leaf whose record
-- is not live — because the CHECK only sees the column this code supplies,
-- and a bug that passes 'live' while selecting seed records would satisfy it.
-- ─────────────────────────────────────────────────────────────────────────────

create table kernel.anchor_batch (
  id              uuid        not null,
  dataset         text        not null default 'live',
  batch_date      date        not null,
  record_count    integer     not null,
  merkle_root     text        not null,

  state           text        not null default 'pending',
  attempts        integer     not null default 0,
  last_error      text,

  -- The receipt. Null until the network has agreed.
  network         text        not null,
  topic_id        text,
  sequence_number bigint,
  consensus_at    timestamptz,
  transaction_id  text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint anchor_batch_pk primary key (id),

  -- One batch per day. This is what makes a re-run a no-op rather than a
  -- second root over the same records.
  constraint anchor_batch_one_per_day unique (dataset, batch_date),

  constraint anchor_batch_live_only check (dataset = 'live'),
  constraint anchor_batch_state_known
    check (state in ('pending', 'published', 'failed')),
  constraint anchor_batch_network_known
    check (network in ('testnet', 'mainnet')),
  constraint anchor_batch_root_is_sha256
    check (merkle_root ~ '^[0-9a-f]{64}$'),
  constraint anchor_batch_not_empty check (record_count > 0),

  -- Published means the network said so. A row claiming publication without a
  -- sequence number is a claim we cannot support, and the whole point of this
  -- table is that its claims can be checked by someone who does not trust us.
  constraint anchor_batch_published_has_receipt check (
    (state = 'published')
      = (topic_id is not null
         and sequence_number is not null
         and consensus_at is not null)
  )
);

create index anchor_batch_pending
  on kernel.anchor_batch (batch_date)
  where state <> 'published';

create table kernel.anchor_leaf (
  batch_id      uuid    not null,
  record_id     uuid    not null,
  position      integer not null,
  salt          text    not null,
  record_digest text    not null,
  leaf_hash     text    not null,

  constraint anchor_leaf_pk primary key (batch_id, record_id),

  -- A record is anchored once and only once. Anchoring it twice would publish
  -- two roots that both claim to fix the same record at the same moment, and a
  -- verifier would have no way to know which one to trust.
  constraint anchor_leaf_record_once unique (record_id),
  constraint anchor_leaf_position_once unique (batch_id, position),

  constraint anchor_leaf_batch_fk
    foreign key (batch_id) references kernel.anchor_batch (id),
  constraint anchor_leaf_position_ordinal check (position >= 0),
  constraint anchor_leaf_salt_shape check (salt ~ '^[0-9a-f]{64}$'),
  constraint anchor_leaf_digest_is_sha256 check (record_digest ~ '^[0-9a-f]{64}$'),
  constraint anchor_leaf_hash_is_sha256 check (leaf_hash ~ '^[0-9a-f]{64}$')
);

-- ── the guard, again, where a bug cannot argue with it ───────────────────────

create or replace function kernel.anchor_leaf_is_live()
returns trigger
language plpgsql
as $$
declare
  v_dataset text;
begin
  select k.dataset into v_dataset
    from kernel.record_key k
   where k.id = new.record_id;

  if v_dataset is null then
    raise exception 'record % is not in the log and cannot be anchored', new.record_id
      using errcode = '23503';
  end if;

  if v_dataset <> 'live' then
    raise exception
      'record % is %, not live — anchoring it would publish fabricated data to a public ledger',
      new.record_id, v_dataset
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger anchor_leaf_live_only
  before insert or update on kernel.anchor_leaf
  for each row execute function kernel.anchor_leaf_is_live();

-- ── append-only ──────────────────────────────────────────────────────────────

create or replace function kernel.anchor_leaf_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'kernel.anchor_leaf is append-only'
    using errcode = '42501';
end;
$$;

create trigger anchor_leaf_no_change
  before update or delete on kernel.anchor_leaf
  for each row execute function kernel.anchor_leaf_append_only();

-- A batch is not append-only, because it acquires a receipt after the fact.
-- But what it says about the records — the root, the count, the day — is fixed
-- at creation, and a published batch is fixed entirely. Retrying a failed
-- publish must produce the same root or it is not a retry.
create or replace function kernel.anchor_batch_settled()
returns trigger
language plpgsql
as $$
begin
  if old.state = 'published' then
    raise exception 'anchor batch % is published and cannot be changed', old.id
      using errcode = '42501';
  end if;

  if new.merkle_root is distinct from old.merkle_root
     or new.record_count is distinct from old.record_count
     or new.batch_date is distinct from old.batch_date
     or new.dataset is distinct from old.dataset then
    raise exception 'the root, count and day of a batch are fixed at creation'
      using errcode = '42501';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger anchor_batch_no_rewrite
  before update on kernel.anchor_batch
  for each row execute function kernel.anchor_batch_settled();

create or replace function kernel.anchor_batch_no_deletion()
returns trigger
language plpgsql
as $$
begin
  raise exception 'anchor batches are not deleted; a published root cannot be unpublished'
    using errcode = '42501';
end;
$$;

create trigger anchor_batch_no_delete
  before delete on kernel.anchor_batch
  for each row execute function kernel.anchor_batch_no_deletion();

-- ── what is left to anchor ───────────────────────────────────────────────────
--
-- Live records with no leaf. Driving the batch from this view rather than from
-- a date range is what makes a network failure delay records instead of losing
-- them: a record missed on the day it was written is picked up by the next run
-- that covers it.

create view kernel.unanchored_record as
  select k.id,
         k.record_class,
         k.type,
         k.recorded_at,
         k.dataset
    from kernel.record_key k
    left join kernel.anchor_leaf l on l.record_id = k.id
   where k.dataset = 'live'
     and l.record_id is null;

-- ── the published record, for anyone ─────────────────────────────────────────
--
-- Roots and receipts only. A verifier needs these and must not need us for
-- anything else.

create view kernel.published_root as
  select b.batch_date,
         b.merkle_root,
         b.record_count,
         b.network,
         b.topic_id,
         b.sequence_number,
         b.consensus_at
    from kernel.anchor_batch b
   where b.state = 'published';

-- ── grants ───────────────────────────────────────────────────────────────────

grant select, insert, update on kernel.anchor_batch to kernel_app;
grant select, insert on kernel.anchor_leaf to kernel_app;
grant select on kernel.unanchored_record to kernel_app;
grant select on kernel.published_root to kernel_app;

-- Salts are the reason a leaf hash cannot be ground back to the record it
-- covers. Handing them to the training role would undo that for every record
-- in the system at once.
revoke all on kernel.anchor_batch from kernel_training;
revoke all on kernel.anchor_leaf from kernel_training;
revoke all on kernel.unanchored_record from kernel_training;
revoke all on kernel.published_root from kernel_training;

-- ── audit ────────────────────────────────────────────────────────────────────

alter table audit.entry drop constraint entry_action_known;
alter table audit.entry add constraint entry_action_known check (action in (
  'record.read',
  'record.write',
  'consent.denied',
  'write.refused',
  'schema.ddl',
  'media.read',
  'media.write',
  'media.refused',
  'anchor.publish',   -- a root was submitted to the network
  'anchor.prove'      -- a proof was handed out for one record
));
