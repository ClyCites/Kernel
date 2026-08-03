-- 0022 — Objection under s.7(3). Work order J2.
--
-- Not the same thing as withdrawal, and conflating the two would be the
-- serious error here. Withdrawal (0021) targets one grant: that grantee, that
-- purpose, stops. An objection targets the processing itself, and it is
-- conditional on the ground the record was collected on — s.7(3) stops
-- processing "except for data collected or processed under subsection (2)".
-- That is why 0019 stores `lawful_basis` per record: the answer to "can this
-- farmer make us stop" is fixed at collection and cannot be reconstructed
-- later. See docs/decisions/0030-objection.md.

create table kernel.objection (
  id            uuid primary key,
  subject       uuid not null,

  -- Null means every record type. A named set is narrower, and a farmer who
  -- objects to observations about their plot has not objected to the delivery
  -- receipts they need for a loan.
  scope         text[] null,

  lodged_at     timestamptz not null,
  lodged_via    text not null,

  -- Who put it on the record. Not always the subject: an officer may lodge
  -- under delegation, because a farmer with no smartphone must still be able
  -- to object. Withdrawal has no such path — see kernel.objection_withdrawal.
  lodged_by     uuid not null,
  delegation    uuid null,

  evidence      jsonb not null default '[]'::jsonb,
  dataset       text not null default 'live',
  recorded_at   timestamptz not null default now(),

  constraint objection_via_known check (lodged_via in (
    'in_person', 'ussd_confirmation', 'written'
  )),
  constraint objection_scope_named check (scope is null or cardinality(scope) > 0),
  constraint objection_delegated_by_another check (
    delegation is null or lodged_by <> subject
  ),
  constraint objection_dataset_known check (dataset in ('live', 'seed'))
);

comment on table kernel.objection is
  'A subject''s objection to processing under s.7(3). Insert-only: withdrawal '
  'is a row in kernel.objection_withdrawal.';

comment on column kernel.objection.scope is
  'Record types the objection covers, or null for all of them. Resolved at '
  'request time against each record''s lawful_basis, never pre-computed.';

create index objection_lookup on kernel.objection (subject, dataset);
create index objection_non_live on kernel.objection (dataset) where dataset <> 'live';

create table kernel.objection_withdrawal (
  id            uuid primary key,
  objection_id  uuid not null references kernel.objection (id),
  withdrawn_at  timestamptz not null,
  withdrawn_by  uuid not null,
  withdrawn_via text not null,
  reason        text null,
  recorded_at   timestamptz not null default now(),

  -- The asymmetry, enforced here as well as in the service. Lodging an
  -- objection protects the subject and may be delegated; withdrawing one
  -- removes that protection, and the party best placed to want it removed is
  -- the one whose access it restricts.
  --
  -- `ussd_confirmation` is absent deliberately: a PIN on a shared handset is
  -- enough to raise a protection and not enough to drop one.
  constraint objection_withdrawal_via_known check (withdrawn_via in (
    'in_person', 'written'
  ))
);

comment on table kernel.objection_withdrawal is
  'A subject re-consenting. Only the subject, and only on evidence at least '
  'as strong as an in-person signature.';

-- One live withdrawal per objection. A second attempt is a no-op rather than
-- a second row.
create unique index objection_withdrawal_once
  on kernel.objection_withdrawal (objection_id);

create or replace function kernel.objection_append_only() returns trigger
language plpgsql as $$
begin
  raise exception
    'objections are append-only; % on % is refused', tg_op, tg_table_name
    using errcode = 'restrict_violation',
          hint = 'An objection is withdrawn by inserting into '
                 'kernel.objection_withdrawal, never by editing the objection.';
end;
$$;

create trigger objection_append_only
  before update or delete on kernel.objection
  for each row execute function kernel.objection_append_only();

create trigger objection_withdrawal_append_only
  before update or delete on kernel.objection_withdrawal
  for each row execute function kernel.objection_append_only();

grant select, insert on kernel.objection to kernel_app;
grant select, insert on kernel.objection_withdrawal to kernel_app;
revoke update, delete, truncate on kernel.objection from kernel_app;
revoke update, delete, truncate on kernel.objection_withdrawal from kernel_app;
