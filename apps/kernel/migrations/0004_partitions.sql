-- 0004 — Partitioning.
--
-- Both record tables are partitioned by month on `recorded_at`. `recorded_at`
-- is chosen over `occurred_at` because it is kernel-assigned and monotonic:
-- a device that has been offline for three weeks appends records whose
-- `occurred_at` is old, and partitioning on that would keep rewriting cold
-- partitions. Records arrive in `recorded_at` order by construction.
--
-- Maintenance strategy
-- --------------------
-- 1. `kernel.ensure_record_partitions(behind, ahead)` is idempotent and is
--    called by the migration runner on every `pnpm migrate`, which is how new
--    months get provisioned. There is no cron, no queue, and no scheduler in
--    this system (brief §3).
-- 2. A DEFAULT partition exists on both tables as a safety net. A record must
--    never be rejected because of an operational oversight (spec §1 P6), so an
--    insert outside every provisioned range lands in DEFAULT rather than
--    failing.
-- 3. Rows in a DEFAULT partition block later creation of a partition covering
--    their range. Monitor `facts.record_default` for a non-zero count: it means
--    partition provisioning has fallen behind and the rows must be moved before
--    the missing month can be created.

create function kernel.ensure_record_partition(p_schema text, p_month date)
returns text
language plpgsql
as $$
declare
  v_start date;
  v_end   date;
  v_name  text;
  v_from  text;
  v_to    text;
begin
  if p_schema not in ('facts', 'inference') then
    raise exception 'unknown record namespace: %', p_schema;
  end if;

  v_start := date_trunc('month', p_month)::date;
  v_end   := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  := format('record_y%sm%s', to_char(v_start, 'YYYY'), to_char(v_start, 'MM'));

  -- Explicit UTC offsets: a bare date literal would be cast using the session
  -- time zone, which would silently move partition boundaries between callers.
  v_from := to_char(v_start, 'YYYY-MM-DD') || ' 00:00:00+00';
  v_to   := to_char(v_end,   'YYYY-MM-DD') || ' 00:00:00+00';

  if not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = p_schema
       and c.relname = v_name
  ) then
    execute format(
      'create table %I.%I partition of %I.record for values from (%L) to (%L)',
      p_schema, v_name, p_schema, v_from, v_to
    );
  end if;

  return format('%s.%s', p_schema, v_name);
end
$$;

comment on function kernel.ensure_record_partition(text, date) is
  'Idempotently create the monthly partition covering p_month.';

create function kernel.ensure_record_partitions(
  p_months_behind int default 1,
  p_months_ahead  int default 24
)
returns int
language plpgsql
as $$
declare
  v_schema text;
  v_offset int;
  v_count  int := 0;
begin
  foreach v_schema in array array['facts', 'inference'] loop
    for v_offset in -p_months_behind .. p_months_ahead loop
      perform kernel.ensure_record_partition(
        v_schema,
        (date_trunc('month', now()) + make_interval(months => v_offset))::date
      );
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end
$$;

comment on function kernel.ensure_record_partitions(int, int) is
  'Provision a window of monthly partitions. Called by the migration runner.';

create table facts.record_default     partition of facts.record     default;
create table inference.record_default partition of inference.record default;

select kernel.ensure_record_partitions(1, 24);
