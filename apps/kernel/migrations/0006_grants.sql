-- 0006 — Grants.
--
-- Invariant 1 (brief §4) in its enforceable form. `kernel_app` — the role the
-- running kernel connects as — receives INSERT and SELECT on the record tables
-- and nothing else. There is no UPDATE grant and no DELETE grant, so there is
-- no privileged path by which a correction could overwrite a record.
--
-- There is deliberately no exception carved out for the kernel-maintained
-- `superseded_by` back-reference. It is derived at read time from the
-- `supersedes` index rather than written back, which removes the last reason
-- anything would ever need UPDATE. See docs/decisions/0002-derived-fields.md.

grant usage on schema facts     to kernel_app;
grant usage on schema inference to kernel_app;
grant usage on schema kernel    to kernel_app;

grant select, insert on facts.record     to kernel_app;
grant select, insert on inference.record to kernel_app;
grant select, insert on kernel.record_key to kernel_app;

-- Stated rather than assumed. Postgres grants none of these by default, but
-- this file is the place an auditor looks to answer "can the app mutate a
-- record?" and the answer should be visible, not inferred.
revoke update, delete, truncate on facts.record      from kernel_app;
revoke update, delete, truncate on inference.record  from kernel_app;
revoke update, delete, truncate on kernel.record_key from kernel_app;

-- The application never runs DDL. Partition creation is a migrator operation.
revoke create on schema facts     from kernel_app;
revoke create on schema inference from kernel_app;
revoke create on schema kernel    from kernel_app;

-- Newly created schemas grant nothing to PUBLIC, but say so explicitly so that
-- a future role added to the cluster does not inherit access by accident.
revoke all on schema facts     from public;
revoke all on schema inference from public;
revoke all on schema kernel    from public;
