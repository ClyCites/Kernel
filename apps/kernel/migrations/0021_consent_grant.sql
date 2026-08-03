-- 0021 — Consent grants. Work order N2, replacing the stub in
-- src/consent/consent.service.ts.
--
-- A grant is a claim a subject made about who may process what, for which
-- purpose, until when. It is not reference data and it is not an entity in
-- `@clycites/schema`; it sits kernel-side, the same position taken by
-- `dataset` (0017), `lawful_basis` (0019) and `party_link` (0019), and for the
-- same reason. See docs/decisions/0029-consent.md.
--
-- Two tables rather than one nullable table. A revocation is a different kind
-- of statement from a grant — it names no purpose, sets no expiry, and cannot
-- be made by the grantee — and folding it into the grant row would mean half
-- the columns are conditionally meaningful. More to the point, keeping them
-- apart is what lets the grant table be strictly INSERT-only: **withdrawal is
-- an insert somewhere else, never an update here**, so no code path exists
-- that can edit a grant after the fact.

create table kernel.consent_grant (
  id            uuid primary key,
  subject       uuid not null,
  grantee       uuid not null,
  purpose       text not null,
  record_types  text[] not null,
  granted_at    timestamptz not null,
  expires_at    timestamptz null,
  granted_via   text not null,
  evidence      jsonb not null default '[]'::jsonb,
  dataset       text not null default 'live',
  recorded_at   timestamptz not null default now(),

  -- Purpose-bound, s.10(1). A grant for credit assessment is not a grant for
  -- market intelligence, and the resolver never falls back to a broader one.
  constraint consent_grant_purpose_known check (purpose in (
    'credit_assessment', 'insurance_underwriting', 'input_supply',
    'market_intelligence', 'traceability_claim', 'advisory',
    'research', 'regulatory_reporting'
  )),

  -- How the subject actually said yes. A grant nobody can show evidence of is
  -- a grant that will not survive a complaint.
  constraint consent_grant_via_known check (granted_via in (
    'in_person_signature', 'ussd_confirmation', 'witnessed'
  )),

  constraint consent_grant_scoped check (cardinality(record_types) > 0),
  constraint consent_grant_not_self check (subject <> grantee),
  constraint consent_grant_dated check (expires_at is null or expires_at > granted_at),
  constraint consent_grant_dataset_known check (dataset in ('live', 'seed'))
);

comment on table kernel.consent_grant is
  'A subject''s permission for one grantee, one purpose, and a named set of '
  'record types. Insert-only: withdrawal is a row in kernel.consent_revocation.';

comment on column kernel.consent_grant.expires_at is
  'Resolved at request time, never at grant time. A grant that has expired by '
  'the moment of the read does not authorise it.';

create index consent_grant_lookup
  on kernel.consent_grant (grantee, subject, purpose);

create index consent_grant_non_live
  on kernel.consent_grant (dataset) where dataset <> 'live';

create table kernel.consent_revocation (
  id           uuid primary key,
  grant_id     uuid not null references kernel.consent_grant (id),
  revoked_at   timestamptz not null,
  revoked_by   uuid not null,
  reason       text null,
  recorded_at  timestamptz not null default now()
);

comment on table kernel.consent_revocation is
  'Withdrawal of a grant, s.10(4). A new record rather than a mutation, so '
  'that "consent was given and later withdrawn" stays answerable.';

-- One live withdrawal per grant. A second attempt is a no-op rather than a
-- second row, so the history cannot be padded.
create unique index consent_revocation_once on kernel.consent_revocation (grant_id);

-- ── append-only ───────────────────────────────────────────────────────────
--
-- Not the registry's refuse_mutation(): these are kernel tables and the
-- message should say so.

create or replace function kernel.consent_append_only() returns trigger
language plpgsql as $$
begin
  raise exception
    'consent records are append-only; % on % is refused', tg_op, tg_table_name
    using errcode = 'restrict_violation',
          hint = 'A grant is withdrawn by inserting into '
                 'kernel.consent_revocation, never by editing the grant.';
end;
$$;

create trigger consent_grant_append_only
  before update or delete on kernel.consent_grant
  for each row execute function kernel.consent_append_only();

create trigger consent_revocation_append_only
  before update or delete on kernel.consent_revocation
  for each row execute function kernel.consent_append_only();

grant select, insert on kernel.consent_grant to kernel_app;
grant select, insert on kernel.consent_revocation to kernel_app;
revoke update, delete, truncate on kernel.consent_grant from kernel_app;
revoke update, delete, truncate on kernel.consent_revocation from kernel_app;
