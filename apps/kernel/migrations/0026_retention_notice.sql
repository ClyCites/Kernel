-- 0026 — The retention notice actually given at enrolment. Work order J5,
-- DPPA s.13(1)(i).
--
-- s.13(1) requires the collector to tell the subject, at the time of
-- collection, a list of things — including (i) the period for which the data
-- will be retained. This table records what was *said*, not what policy now
-- says. A farmer enrolled in March was told something; if the policy changes
-- in June, the March notice is what governs that farmer's expectations and it
-- is the March wording a regulator will ask to see.
--
-- So the row is a historical fact about a conversation, and like every other
-- historical fact in this system it is append-only. A "current retention
-- policy" table would answer a different and much less useful question.
--
-- NOT BUILT, deliberately: no expiry job, no deletion scheduler, nothing that
-- acts on `period_stated`. The period a record may lawfully be held for comes
-- from the 2021 Regulations read with the Agricultural Credit statutes and the
-- cooperative societies rules, and that reading is unresolved — open decision
-- D3, blocked on counsel. Writing a job that deletes on a period we cannot
-- yet justify would destroy records on a guess, and the destruction is the
-- one part that cannot be undone. Recording the notice is the part that can
-- be done honestly today, and it is the part that must exist before any
-- expiry job could ever be written: the job would need to know what each
-- subject was told.

create table kernel.retention_notice (
  id             uuid primary key,

  -- The party the notice was given to. Not a foreign key: parties live in
  -- facts.record as documents, and this table must not depend on the record
  -- store's supersession chain. The id is the stable one, as everywhere else.
  party          uuid not null,

  -- The notice as it was actually given, in full. Not a template id, not a
  -- version number pointing at a document that may itself be edited. If the
  -- text is not stored here the notice is unprovable.
  notice_text    text not null,

  -- What the subject was told about how long. Free text on purpose: "until
  -- three years after your last delivery" is a real answer and is not a
  -- duration. Machine-readable retention would be a lie about how settled
  -- this is — see D3.
  period_stated  text not null,

  -- The s.7 or s.9 ground the collection was said to rest on, s.13(1)(c).
  lawful_basis   text not null,

  -- What the data was said to be for, s.13(1)(b). More than one is normal.
  purposes       text[] not null,

  -- s.13 requires the subject be *informed*, which a notice in a language
  -- they do not read does not achieve. Recorded so that claim is checkable.
  language       text not null,

  -- How the notice reached them, and who gave it. An enrolment notice read
  -- aloud by a cooperative officer is the common case here and is fine; a
  -- notice nobody can say was delivered is not.
  given_via      text not null,
  given_by       uuid null,
  given_at       timestamptz not null,

  dataset        text not null default 'live',
  recorded_at    timestamptz not null default now(),

  constraint retention_notice_text_present check (length(btrim(notice_text)) > 0),
  constraint retention_notice_period_present check (length(btrim(period_stated)) > 0),
  constraint retention_notice_language_present check (length(btrim(language)) > 0),
  constraint retention_notice_purposed check (cardinality(purposes) > 0),

  constraint retention_notice_basis_known check (lawful_basis in (
    'consent', 'legal_authorisation', 'public_duty', 'national_security',
    'law_enforcement', 'contract_performance', 'medical', 'legal_obligation',
    'special_data_consent'
  )),

  constraint retention_notice_via_known check (given_via in (
    'in_person_reading', 'in_person_signature', 'ussd_confirmation',
    'sms', 'printed_handout', 'witnessed'
  )),

  constraint retention_notice_dataset_known check (dataset in ('live', 'seed'))
);

comment on table kernel.retention_notice is
  'DPPA s.13(1)(i). The notice given to a party at enrolment, as given. '
  'Append-only: a later notice is a new row, and the earlier one still '
  'governs the period before it.';

comment on column kernel.retention_notice.period_stated is
  'What the subject was told, in the words used. Deliberately not a machine '
  'readable duration: the lawful period is unresolved (D3) and a parsed '
  'interval would invite a job to act on it.';

-- The common read is "what was this party told, most recent first", and the
-- second is "what were they told as at some past date", which the same index
-- serves.
create index retention_notice_by_party
  on kernel.retention_notice (party, given_at desc);

create index retention_notice_non_live
  on kernel.retention_notice (dataset) where dataset <> 'live';

-- Its own function rather than kernel.consent_append_only(): that one's hint
-- tells the caller to insert a revocation, which is not the remedy here.
create or replace function kernel.retention_notice_append_only() returns trigger
language plpgsql as $$
begin
  raise exception
    'a retention notice is a record of what was said; % is refused', tg_op
    using errcode = 'restrict_violation',
          hint = 'A changed policy is a new notice, given to the subject and '
                 'inserted as a new row. The earlier notice still governs the '
                 'period before it.';
end;
$$;

create trigger retention_notice_append_only
  before update or delete on kernel.retention_notice
  for each row execute function kernel.retention_notice_append_only();

grant select, insert on kernel.retention_notice to kernel_app;
revoke update, delete, truncate on kernel.retention_notice from kernel_app;
