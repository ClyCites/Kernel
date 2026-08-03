-- 0023 — The one read of the audit log the application is allowed. Work order J3.
--
-- s.24(1)(c) gives a data subject the identity of every third party who has
-- had access to their data. That question is answerable only from audit.entry,
-- and 0017 gave kernel_app INSERT and nothing else on purpose: an application
-- that can read who has been looking at whom hands that answer to anyone who
-- compromises it.
--
-- Both constraints are real, so neither is relaxed. This function is the whole
-- of the application's read access to the log: one subject at a time, allowed
-- disclosures only, never the log itself. kernel_app still cannot select from
-- audit.entry, and adding a `select` to audit.repository.ts still fails at
-- runtime. See docs/decisions/0031-subject-access.md.

create or replace function audit.disclosures_to(p_subject uuid, p_dataset text)
returns table (
  occurred_at   timestamptz,
  actor         uuid,
  purpose       text,
  access        text,
  record_types  text[],
  records       uuid[]
)
language sql
stable
security definer
-- An empty search_path is not decoration. A definer function that resolves an
-- unqualified name through the caller's search_path runs whatever the caller
-- put there, with the owner's rights.
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
     and e.action = 'record.read'
     and e.outcome = 'allowed'
     -- Reading your own record is not a third party having had access to it,
     -- and a disclosure list padded with the subject's own visits buries the
     -- entries that matter.
     and e.actor is distinct from p_subject
   order by e.occurred_at desc
$$;

revoke all on function audit.disclosures_to(uuid, text) from public;
grant execute on function audit.disclosures_to(uuid, text) to kernel_app;

comment on function audit.disclosures_to(uuid, text) is
  'DPPA s.24(1)(c). The only path from the application into the audit log, '
  'scoped to one subject and to disclosures that were allowed.';
