-- 0036 - Owner-only reset for the reproducible sandbox corpus.
--
-- The application role cannot call this and cannot delete any of these rows.
-- A scheduled owner task clears only dataset=seed, then the ordinary public
-- API repopulates it. Trigger disabling is transaction-scoped: any failure
-- rolls the deletes and trigger state back together.

create or replace function kernel.reset_seed_corpus()
returns bigint
language plpgsql
set search_path = pg_catalog, kernel, facts, inference, audit
as $$
declare
  removed bigint := 0;
  affected bigint;
begin
  alter table kernel.consent_grant disable trigger user;
  alter table kernel.consent_revocation disable trigger user;
  alter table kernel.objection disable trigger user;
  alter table kernel.objection_withdrawal disable trigger user;
  alter table kernel.party_link disable trigger user;
  alter table kernel.retention_notice disable trigger user;
  alter table kernel.disclosure_notification disable trigger user;
  alter table inference.validation disable trigger user;
  alter table facts.record disable trigger user;
  alter table inference.record disable trigger user;
  alter table kernel.record_key disable trigger user;

  delete from kernel.confirmation_request where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.media_reference where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.upload_session where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.media_object where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from inference.validation where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.consent_revocation
   where grant_id in (select id from kernel.consent_grant where dataset = 'seed');
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.consent_grant where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.objection_withdrawal
   where objection_id in (select id from kernel.objection where dataset = 'seed');
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.objection where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.disclosure_notification where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.retention_notice where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.party_link where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from audit.entry where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from facts.record where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from inference.record where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;
  delete from kernel.record_key where dataset = 'seed';
  get diagnostics affected = row_count; removed := removed + affected;

  alter table kernel.consent_grant enable trigger user;
  alter table kernel.consent_revocation enable trigger user;
  alter table kernel.objection enable trigger user;
  alter table kernel.objection_withdrawal enable trigger user;
  alter table kernel.party_link enable trigger user;
  alter table kernel.retention_notice enable trigger user;
  alter table kernel.disclosure_notification enable trigger user;
  alter table inference.validation enable trigger user;
  alter table facts.record enable trigger user;
  alter table inference.record enable trigger user;
  alter table kernel.record_key enable trigger user;

  return removed;
end;
$$;

revoke all on function kernel.reset_seed_corpus() from public;
revoke all on function kernel.reset_seed_corpus() from kernel_app;
grant execute on function kernel.reset_seed_corpus() to clycites_owner;

comment on function kernel.reset_seed_corpus() is
  'Owner-only transactional deletion of fabricated seed rows; live rows are never targeted.';