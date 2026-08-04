-- 0028 — The training role. Work order G / P4, spec §6.2 rule 3.
--
-- The requirement is that a training pipeline *cannot* read inferences. Not
-- that it must remember to filter them out.
--
-- A filter is a promise. `where record_class = 'observation'` is one line, it
-- is correct today, and it will be omitted by somebody in a hurry eighteen
-- months from now — in an ad-hoc export, a notebook, a backfill script. The
-- failure is silent: the corpus looks fine, the model trains on its own
-- output, and error compounds while confidence does not. By the time it is
-- visible there is no clean corpus left to measure the damage against,
-- because the damage is in the corpus.
--
-- So the guard is a database role with no privileges on the inference schema
-- at all. A query that names inference.record fails with "permission denied
-- for schema inference" before it returns a row. The training path physically
-- cannot see what it must not see, and the enforcement survives every future
-- caller including the ones nobody has written yet.
--
-- Read-only, and on facts.record only. Not on kernel.record_key either: the
-- key registry spans both namespaces and lists the id, type and class of every
-- inference in the system. It leaks nothing about a prediction's contents, but
-- a training pipeline has no business enumerating them.

do $$
declare
  pw text := current_setting('kernel.training_password', true);
begin
  if pw is null or pw = '' then
    raise exception
      'kernel.training_password is not set — the migration runner must supply KERNEL_TRAINING_PASSWORD';
  end if;

  if exists (select 1 from pg_roles where rolname = 'kernel_training') then
    execute format('alter role kernel_training with login password %L', pw);
  else
    execute format(
      'create role kernel_training with login nosuperuser nocreatedb nocreaterole noinherit password %L',
      pw
    );
  end if;
end
$$;

grant usage on schema facts to kernel_training;
grant select on facts.record to kernel_training;

-- Stated, not assumed. This file is where an auditor answers "can the training
-- pipeline see a prediction?", and the answer should be visible rather than
-- inferred from the absence of a grant.
revoke all on schema inference from kernel_training;
revoke all on schema kernel from kernel_training;
revoke all on all tables in schema inference from kernel_training;
revoke all on all tables in schema kernel from kernel_training;

revoke insert, update, delete, truncate on facts.record from kernel_training;
revoke create on schema facts from kernel_training;

-- Future tables in the inference schema must not become readable because
-- somebody forgot to revoke. Default privileges grant nothing to a named role
-- unless asked, but the registry table added in 0003 is the sort of thing that
-- gets a sibling later.
alter default privileges in schema inference revoke all on tables from kernel_training;
alter default privileges in schema kernel revoke all on tables from kernel_training;
