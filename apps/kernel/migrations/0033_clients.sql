-- 0033 — OAuth clients and authority to act for a party.
--
-- Authentik owns credentials. These tables contain only the public client
-- identifier, its kernel-side capability ceiling, and immutable statements
-- made by parties about which client may represent them.

create table kernel.client (
  id            uuid primary key,
  client_id     text not null,
  display_name  text not null,
  owner_party   uuid not null,
  scopes        text[] not null,
  status        text not null,
  recorded_at   timestamptz not null default now(),

  constraint client_id_bounded check (length(client_id) between 1 and 200),
  constraint client_name_bounded check (length(display_name) between 1 and 200),
  constraint client_scopes_known check (
    cardinality(scopes) > 0 and
    scopes <@ array[
      'records:read', 'records:write', 'registry:read',
      'media:read', 'media:write', 'sync'
    ]::text[]
  ),
  constraint client_status_known check (status in ('active', 'suspended', 'retired'))
);

comment on table kernel.client is
  'Immutable versions of an Authentik OAuth client registration. The latest row for a client_id is current.';

create index client_current on kernel.client (client_id, recorded_at desc, id desc);

create table kernel.client_authorisation (
  id           uuid primary key,
  party        uuid not null,
  client_id    text not null,
  scopes       text[] not null,
  granted_at   timestamptz not null,
  expires_at   timestamptz null,
  granted_via  text not null,
  recorded_at  timestamptz not null default now(),

  constraint client_authorisation_scoped check (cardinality(scopes) > 0),
  constraint client_authorisation_dated check (
    expires_at is null or expires_at > granted_at
  ),
  constraint client_authorisation_via_bounded check (
    length(granted_via) between 1 and 100
  )
);

create index client_authorisation_lookup
  on kernel.client_authorisation (party, client_id, granted_at desc);

create table kernel.client_authorisation_revocation (
  id             uuid primary key,
  authorisation  uuid not null references kernel.client_authorisation (id),
  revoked_at     timestamptz not null,
  revoked_by     uuid not null,
  reason         text null,
  recorded_at    timestamptz not null default now(),

  constraint client_authorisation_reason_bounded check (
    reason is null or length(reason) <= 500
  )
);

create unique index client_authorisation_revocation_once
  on kernel.client_authorisation_revocation (authorisation);

create or replace function kernel.client_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'client records are append-only; % on % is refused', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

create trigger client_append_only
  before update or delete on kernel.client
  for each row execute function kernel.client_append_only();

create trigger client_authorisation_append_only
  before update or delete on kernel.client_authorisation
  for each row execute function kernel.client_append_only();

create trigger client_authorisation_revocation_append_only
  before update or delete on kernel.client_authorisation_revocation
  for each row execute function kernel.client_append_only();

grant select, insert on kernel.client to kernel_app;
grant select, insert on kernel.client_authorisation to kernel_app;
grant select, insert on kernel.client_authorisation_revocation to kernel_app;
revoke update, delete, truncate on kernel.client from kernel_app;
revoke update, delete, truncate on kernel.client_authorisation from kernel_app;
revoke update, delete, truncate on kernel.client_authorisation_revocation from kernel_app;

alter table audit.entry add column client_id text null;
alter table audit.entry add column acting_for uuid null;

comment on column audit.entry.client_id is
  'The OAuth client that made the request, separate from the party receiving the disclosure.';
comment on column audit.entry.acting_for is
  'The party represented by the client and therefore the recipient of any disclosure.';

create index entry_client on audit.entry (client_id, occurred_at desc)
  where client_id is not null;