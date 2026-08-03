-- 0017 — The audit log.
--
-- Not a log. A statutory record.
--
-- Data Protection and Privacy Act, 2019 s.24(1)(c) gives a data subject the
-- right to be told the identity of every third party who has accessed their
-- data. s.16(4) requires that when a record is corrected, the parties who
-- received the incorrect version are notified. Neither question is answerable
-- from application logs — they are answerable only from a durable, complete,
-- queryable record of access, which is this table. That raises the bar twice
-- over: on completeness, because a missed entry is a legally wrong answer to a
-- subject's request; and on append-only discipline, because an editable access
-- record is not evidence of anything.
--
-- Four properties, each enforced here rather than in application code:
--
--   1. IDS ONLY, NEVER BODIES. The columns that can hold record content are
--      uuid arrays, and the one jsonb column is a query descriptor with a hard
--      size cap. An audit log full of personal data is a second copy of the
--      thing it protects, sitting in a schema the application can write but
--      cannot read — which is worse than not having it.
--
--   2. INSERT ONLY FOR THE APPLICATION. `kernel_app` gets INSERT and nothing
--      else: no SELECT, no UPDATE, no DELETE. Reading the log is a separate
--      privileged path, because a compromised application that can read the
--      access log learns who has been looking at whom.
--
--   3. APPEND-ONLY FOR EVERYONE. A trigger refuses UPDATE and DELETE for every
--      role including the owner, on the same reasoning as 0016.
--
--   4. DDL IS CAPTURED. 0016 admits that an owner can drop the deletion guard.
--      This is what makes that admission bearable: dropping it is a DDL event,
--      and DDL events land here.
--
-- REQUIRES A SUPERUSER MIGRATOR. `create event trigger` is superuser-only in
-- PostgreSQL — there is no grantable privilege for it. If this migration fails
-- with "permission denied to create event trigger", the deploy has correctly
-- stopped: run this file as a superuser rather than removing the triggers.
-- A silently absent DDL capture is exactly the failure this is here to prevent.
--
-- See docs/decisions/0025-audit-log.md.

create schema audit;

comment on schema audit is
  'Statutory access record (DPPA s.24(1)(c), s.16(4)). Written by the application, readable only by a privileged operator.';

create table audit.entry (
  id uuid primary key,

  -- Kernel clock. There is no client-supplied time here and there must not be:
  -- a caller who can date their own access entry can date it out of a
  -- disclosure request.
  occurred_at timestamptz not null default now(),

  -- 0011. Seed access must never surface in a real subject's disclosure list,
  -- and the only way to guarantee that is to carry the discriminator per entry
  -- rather than infer it later from the records named.
  dataset text not null default 'live'
    constraint entry_dataset_known check (dataset in ('live', 'seed')),

  action text not null
    constraint entry_action_known check (action in (
      'record.read',      -- records were disclosed to a party
      'record.write',     -- a record was appended
      'consent.denied',   -- a disclosure was refused
      'write.refused',    -- an append was refused
      'schema.ddl'        -- the shape of the database changed
    )),

  outcome text not null
    constraint entry_outcome_known check (outcome in ('allowed', 'denied')),

  -- ConsentReason for a disclosure, RecordRejected code for a write, command
  -- tag for DDL. Denials matter more than successes: a shifting denial rate is
  -- the earliest signal that something upstream has broken, and it cannot be
  -- read out of a column that only ever says 'ok'.
  reason text
    constraint entry_reason_bounded check (reason is null or length(reason) <= 200),

  -- The verified subject claim, null when none reached the kernel. Not a
  -- foreign key: the actor may be a party the kernel holds no record for.
  actor uuid,

  purpose text
    constraint entry_purpose_bounded check (purpose is null or length(purpose) <= 64),

  -- Who the data was about. This is the column s.24(1)(c) is answered from.
  subjects uuid[] not null default '{}',

  -- Which records. This is the column s.16(4) is answered from: given a
  -- corrected record, who received the version before it.
  records uuid[] not null default '{}',

  record_types text[] not null default '{}',

  -- A description of the query, not its results. Filter names and values that
  -- are themselves identifiers or enums — never a record body, never a field
  -- value copied out of one.
  detail jsonb
    constraint entry_detail_bounded
      check (detail is null or length(detail::text) <= 2048),

  correlation_id text
    constraint entry_correlation_bounded
      check (correlation_id is null or length(correlation_id) <= 128)
);

comment on table audit.entry is
  'One row per access decision. Ids and query descriptors only — never record contents.';

comment on column audit.entry.detail is
  'Query descriptor. Size-capped because a cap is checkable and "we promise not to" is not.';

comment on column audit.entry.subjects is
  'Answers DPPA s.24(1)(c): which third parties accessed this subject''s data.';

comment on column audit.entry.records is
  'Answers DPPA s.16(4): who received a record before it was corrected.';

-- GIN, because both statutory questions are containment searches over an array,
-- and partial on live because a disclosure request is never about seed access.
create index entry_subjects on audit.entry using gin (subjects)
  where dataset = 'live';

create index entry_records on audit.entry using gin (records)
  where dataset = 'live';

-- The denial-rate query, which is the operational reason to look at this table
-- at all. Partial, because successes are almost every row.
create index entry_denials on audit.entry (occurred_at desc, reason)
  where outcome = 'denied';

create index entry_actor on audit.entry (actor, occurred_at desc)
  where dataset = 'live';

/* ── append-only, for every role ──────────────────────────────────────── */

create or replace function audit.refuse_mutation()
  returns trigger
  language plpgsql
as $$
begin
  raise exception 'audit entries cannot be % once written', lower(tg_op)
    using errcode = 'restrict_violation',
          hint = 'The access record is evidence. Correcting it means appending, '
                 'not editing. See docs/decisions/0025-audit-log.md.';
end
$$;

create trigger entry_append_only
  before update or delete on audit.entry
  for each row execute function audit.refuse_mutation();

/* ── DDL capture ──────────────────────────────────────────────────────── */

-- security definer so the entry is written even when the DDL is performed by a
-- role with no rights on this table at all. search_path is pinned, because a
-- definer function that resolves names through the caller's search_path is a
-- privilege escalation waiting to be written up.
create or replace function audit.record_ddl()
  returns event_trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, audit
as $$
declare
  command record;
begin
  for command in select * from pg_event_trigger_ddl_commands() loop
    insert into audit.entry (id, action, outcome, reason, detail)
    values (
      gen_random_uuid(),
      'schema.ddl',
      'allowed',
      command.command_tag,
      jsonb_build_object(
        'object', command.object_identity,
        'object_type', command.object_type,
        'schema', command.schema_name,
        'role', current_user
      )
    );
  end loop;
end
$$;

create or replace function audit.record_drop()
  returns event_trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, audit
as $$
declare
  dropped record;
begin
  -- `original` and `normal` only: a `drop table` cascades to dozens of internal
  -- objects, and burying "somebody dropped the deletion guard" under forty
  -- index entries defeats the purpose.
  for dropped in
    select * from pg_event_trigger_dropped_objects()
    where original or normal
  loop
    insert into audit.entry (id, action, outcome, reason, detail)
    values (
      gen_random_uuid(),
      'schema.ddl',
      'allowed',
      'DROP ' || dropped.object_type,
      jsonb_build_object(
        'object', dropped.object_identity,
        'object_type', dropped.object_type,
        'schema', dropped.schema_name,
        'role', current_user
      )
    );
  end loop;
end
$$;

create event trigger audit_ddl_command_end
  on ddl_command_end
  execute function audit.record_ddl();

create event trigger audit_sql_drop
  on sql_drop
  execute function audit.record_drop();

/* ── grants ───────────────────────────────────────────────────────────── */
--
-- Same reasoning as 0006: this is the file an auditor looks at, so the negative
-- space is written out rather than left to be inferred from what is absent.

grant usage on schema audit to kernel_app;
grant insert on audit.entry to kernel_app;

revoke select, update, delete, truncate, references, trigger
  on audit.entry from kernel_app;

revoke create on schema audit from kernel_app;
revoke all on schema audit from public;
revoke all on audit.entry from public;
