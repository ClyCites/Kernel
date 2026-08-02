-- 0001 — Roles.
--
-- Invariant 1 (brief §4) is enforced at the database role level, not in
-- application code. `kernel_app` is granted INSERT and SELECT on record tables
-- in 0006 and nothing else: no UPDATE, no DELETE, no DDL. An application bug
-- that tries to mutate a record fails at the database, not at a code review.
--
-- The password is supplied by the migration runner as a transaction-local
-- setting so it never appears in a file under version control.

do $$
declare
  pw text := current_setting('kernel.app_password', true);
begin
  if pw is null or pw = '' then
    raise exception
      'kernel.app_password is not set — the migration runner must supply KERNEL_APP_PASSWORD';
  end if;

  if exists (select 1 from pg_roles where rolname = 'kernel_app') then
    execute format('alter role kernel_app with login password %L', pw);
  else
    execute format(
      'create role kernel_app with login nosuperuser nocreatedb nocreaterole noinherit password %L',
      pw
    );
  end if;
end
$$;
