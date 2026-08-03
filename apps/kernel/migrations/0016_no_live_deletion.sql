-- 0016 — Live records cannot be deleted. Seed records can.
--
-- 0001 enforces append-only by withholding DELETE from `kernel_app`. That binds
-- the application and nothing else: `clycites_owner` owns these tables and
-- retains DELETE, and at the Postgres level that cannot be durably revoked —
-- an owner can re-grant to themselves, so any revocation against the owner is
-- advisory. A trigger is the one mechanism that applies to every role.
--
-- Not a blanket refusal, because owner DELETE has a legitimate use: a stale
-- seed corpus has to be clearable so it can be regenerated. Changing a seed
-- fixture changes the contents of records whose ids are derived from the same
-- fixture, and re-running the seed then collides 409 on every one of them. The
-- corpus is fabricated and reproducible; refusing to clear it would buy nothing
-- and would push somebody toward `drop schema ... cascade` instead.
--
-- So: `seed` deletes pass, `live` deletes raise, for everyone.
--
-- HONEST LIMIT, stated rather than glossed: the owner can drop this trigger and
-- then delete whatever they like. This is not tamper-proofing and cannot be —
-- see the layered model in docs/decisions/0001. What it does is convert silent
-- data loss into an act that leaves a mark, because dropping a trigger is a DDL
-- event and 0025 captures DDL events. The realistic threat here is not a
-- malicious operator, it is a tired one running a cleanup statement against the
-- wrong database at the wrong hour. This stops that outright.
--
-- Anchoring (work order I) is the layer that actually closes the gap, by
-- putting the evidence somewhere we do not control.

create or replace function kernel.refuse_live_deletion()
  returns trigger
  language plpgsql
as $$
begin
  if old.dataset = 'live' then
    raise exception
      'refusing to delete live record % from %.%',
      old.id, tg_table_schema, tg_table_name
      using errcode = 'restrict_violation',
            hint = 'Records are append-only: supersede or retract, do not '
                   'delete. Only dataset=seed rows may be removed. See '
                   'docs/decisions/0001-append-only-enforcement.md.';
  end if;

  return old;
end
$$;

comment on function kernel.refuse_live_deletion() is
  'Applies to every role including the owner. Seed rows may be cleared; live rows may not.';

-- `for each row`, not a statement trigger: the discriminator is per row, and a
-- statement-level check could not tell a seed-only delete from a mixed one.
create trigger record_no_live_deletion
  before delete on facts.record
  for each row execute function kernel.refuse_live_deletion();

create trigger inference_record_no_live_deletion
  before delete on inference.record
  for each row execute function kernel.refuse_live_deletion();

create trigger record_key_no_live_deletion
  before delete on kernel.record_key
  for each row execute function kernel.refuse_live_deletion();
