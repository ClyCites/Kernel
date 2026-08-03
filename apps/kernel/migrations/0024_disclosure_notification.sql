-- 0024 — Notifying the parties who received the old version. Work order J4.
--
-- s.16(4): on complying with a correction or deletion request, the controller
-- shall inform each person to whom the personal data has been disclosed. 0017
-- named this as one of the two statutory questions the audit log exists to
-- answer, and pointed at the `records` column. This is that answer.
--
-- The same shape as 0023 and for the same reason. J3 asked "given a subject,
-- who read their data"; this asks "given a record, who received it", which is
-- the same table read the other way. kernel_app still has INSERT on
-- audit.entry and nothing else — a second security-definer function scoped to
-- one record, not a widened grant.
--
-- See docs/decisions/0032-disclosure-notification.md.

create or replace function audit.recipients_of(
  p_record  uuid,
  p_dataset text,
  p_exclude uuid[]
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
-- 0023 explains why this is empty rather than absent.
set search_path = ''
as $$
  select e.actor as recipient,
         min(e.occurred_at) as first_seen,
         max(e.occurred_at) as last_seen,
         count(*) as disclosures
    from audit.entry e
   where p_record = any(e.records)
     -- 0011. A read of the seed corpus is not a disclosure of anybody's data,
     -- and carrying the discriminator per entry is what makes that checkable
     -- here rather than inferable later.
     and e.dataset = p_dataset
     and e.action = 'record.read'
     -- A refused request disclosed nothing. Notifying on one would tell a
     -- party about a record they were never shown, which is itself a
     -- disclosure — of the record's existence, to someone with no right to it.
     and e.outcome = 'allowed'
     -- Nobody to notify. An entry with no verified actor is a gap in the log
     -- rather than a recipient, and it is visible as a gap because the count
     -- of entries and the count of recipients differ.
     and e.actor is not null
     and not (e.actor = any(p_exclude))
   group by e.actor
$$;

revoke all on function audit.recipients_of(uuid, text, uuid[]) from public;
grant execute on function audit.recipients_of(uuid, text, uuid[]) to kernel_app;

comment on function audit.recipients_of(uuid, text, uuid[]) is
  'DPPA s.16(4). Third parties who received one record, for notifying them '
  'that it has been corrected or retracted. The exclusion list only narrows.';

/* ── the obligation ────────────────────────────────────────────────────── */

-- Raised, not sent. Delivery is an adapter concern — SMS, email, a webhook —
-- and none of it belongs in the kernel. What belongs here is the obligation
-- itself, made countable, so that an outstanding queue reads as a statutory
-- failure in progress rather than as a backlog.

create table kernel.disclosure_notification (
  id             uuid primary key,

  -- The record as it was when they saw it.
  record_id      uuid not null,

  -- What replaced it: the superseding record, or the retraction.
  correction_id  uuid not null,

  -- Not a foreign key. A recipient may be a party the kernel holds no record
  -- for, exactly as audit.entry.actor may be.
  recipient      uuid not null,

  dataset        text not null default 'live',
  raised_at      timestamptz not null default now(),

  -- Null until an adapter reports back. The pair is the compliance signal.
  delivered_at   timestamptz null,
  channel        text null,

  constraint disclosure_notification_dataset_known
    check (dataset in ('live', 'seed')),
  constraint disclosure_notification_channel_known
    check (channel is null or channel in (
      'sms', 'ussd', 'email', 'webhook', 'in_person'
    )),
  -- Half a delivery record is not evidence of one.
  constraint disclosure_notification_delivery_paired
    check ((delivered_at is null) = (channel is null)),
  constraint disclosure_notification_corrects_another
    check (record_id <> correction_id)
);

comment on table kernel.disclosure_notification is
  'DPPA s.16(4). One row per recipient per correction event: the obligation to '
  'tell someone the version they received has changed.';

comment on column kernel.disclosure_notification.delivered_at is
  'Set once by whatever actually sends. Write-once — see the trigger below.';

-- One notification per recipient per correction event. A record corrected
-- twice raises a second set, because s.16(4) attaches to complying with a
-- request and there have been two.
create unique index disclosure_notification_once
  on kernel.disclosure_notification (record_id, correction_id, recipient);

-- The gauge. Partial, because the outstanding set is the small one and the
-- delivered set grows without bound.
create index disclosure_notification_outstanding
  on kernel.disclosure_notification (dataset, raised_at)
  where delivered_at is null;

create index disclosure_notification_recipient
  on kernel.disclosure_notification (recipient, raised_at desc);

/* ── append-only, with one write-once field ────────────────────────────── */

-- Every prior store in this schema is insert-only and records a change of
-- state as a second row. This one does not, and the exception is deliberate:
-- a delivery receipt with no obligation behind it is not a thing that can
-- exist, so the two are one row and the transition is made one-way here
-- instead. Nothing already written can be altered or removed, which is the
-- property the append-only rule is actually protecting.

create or replace function kernel.disclosure_notification_write_once()
  returns trigger
  language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a disclosure notification cannot be deleted'
      using errcode = 'restrict_violation',
            hint = 'An obligation under s.16(4) does not stop existing '
                   'because discharging it was inconvenient.';
  end if;

  if old.delivered_at is not null then
    raise exception 'notification % has already been delivered', old.id
      using errcode = 'restrict_violation',
            hint = 'Delivery is recorded once. A second attempt is a second '
                   'notification, not an edit of the first.';
  end if;

  if (new.id, new.record_id, new.correction_id, new.recipient,
      new.dataset, new.raised_at)
     is distinct from
     (old.id, old.record_id, old.correction_id, old.recipient,
      old.dataset, old.raised_at)
  then
    raise exception 'only delivery may be recorded against a notification'
      using errcode = 'restrict_violation',
            hint = 'Who was owed what, and when it was raised, are fixed at '
                   'the moment the correction landed.';
  end if;

  return new;
end
$$;

create trigger disclosure_notification_write_once
  before update or delete on kernel.disclosure_notification
  for each row execute function kernel.disclosure_notification_write_once();

-- The column list is a second lock on the same door. The trigger is the one
-- that carries the reasoning; this makes the wrong statement fail earlier.
grant select, insert on kernel.disclosure_notification to kernel_app;
grant update (delivered_at, channel) on kernel.disclosure_notification to kernel_app;
revoke delete, truncate on kernel.disclosure_notification from kernel_app;
