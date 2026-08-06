-- 0035 — Self-service clients are confined to the seed corpus.

alter table kernel.client
  add column dataset text not null default 'live',
  add constraint client_dataset_known check (dataset in ('live', 'seed'));

comment on column kernel.client.dataset is
  'The maximum corpus this OAuth client can reach. Seed clients can never be authorised by a party.';

create table kernel.sandbox_registration (
  id                uuid primary key,
  client_id         text not null unique,
  developer_subject uuid not null,
  terms_version     text not null,
  accepted_at       timestamptz not null,
  dataset           text not null default 'seed' check (dataset = 'seed'),
  recorded_at       timestamptz not null default now(),

  constraint sandbox_terms_version_bounded
    check (length(terms_version) between 1 and 100)
);

comment on table kernel.sandbox_registration is
  'Append-only acceptance record for an email-verified Authentik developer client. Contains no credential or email address.';

create trigger sandbox_registration_append_only
  before update or delete on kernel.sandbox_registration
  for each row execute function kernel.client_append_only();

create or replace function kernel.refuse_sandbox_client_authorisation()
returns trigger language plpgsql as $$
declare
  client_dataset text;
begin
  select dataset into client_dataset
    from kernel.client
   where client_id = new.client_id
   order by recorded_at desc, id desc
   limit 1;

  if client_dataset = 'seed' then
    raise exception 'sandbox client % cannot be authorised by a party', new.client_id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger sandbox_client_cannot_receive_party_authority
  before insert on kernel.client_authorisation
  for each row execute function kernel.refuse_sandbox_client_authorisation();

grant select, insert on kernel.sandbox_registration to kernel_app;
revoke update, delete, truncate on kernel.sandbox_registration from kernel_app;