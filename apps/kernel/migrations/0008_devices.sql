-- 0008 — Device registry.
--
-- Phase 6. A device is operational state, not a fact about the world, so it
-- lives in `kernel` rather than `facts` and is not a record: it has no
-- provenance, cannot be superseded, and is never returned by a read.
--
-- It is still append-only. There is no UPDATE grant here either, because a
-- device whose binding changed is a different device — re-registering the same
-- id against a different party is a signal worth refusing rather than a state
-- transition worth recording. The envelope's `device_id` remains a free string
-- (spec §2.4); registration is what gives a particular value an owner.

create table kernel.device (
  device_id     uuid        primary key,
  registered_by uuid        not null,
  label         text        not null,
  registered_at timestamptz not null default now()
);

comment on table kernel.device is
  'Devices permitted to drain an outbox. Append-only; see docs/decisions/0008-sync.md.';

create index device_registered_by_idx on kernel.device (registered_by);

grant select, insert on kernel.device to kernel_app;
revoke update, delete, truncate on kernel.device from kernel_app;
