-- 0027 — `validated_by`: what reality later said about a prediction.
-- Work order G / P4, spec §6.3.
--
-- A March yield prediction is settled in August by the deliveries that
-- actually happened. That linkage is the evaluation dataset for every model
-- this system will ever run, it is worth more than the model, and it cannot be
-- reconstructed retroactively — by the time anyone wants it, nobody remembers
-- which observations were the ones that answered which prediction.
--
-- Two things it is not:
--
--   1. It is not a mutation of the inference. The log is append-only, so
--      `validated_by` cannot be edited into the stored body. It is derived on
--      read from this table, exactly as `superseded_by` and `stale` are
--      (0002-derived-fields). An inference submitted with a `validated_by` has
--      that field discarded on ingest.
--
--   2. It does not promote the prediction. The prediction acquires a verdict
--      and stays an inference forever. There is no path from this table into
--      facts.record and there must never be one: a predicted yield that became
--      a fact because it turned out roughly right is precisely the
--      contamination the two-namespace split exists to prevent.

create table inference.validation (
  id            uuid primary key,

  -- The prediction being settled. In the inference namespace by definition.
  inference_id  uuid not null,

  -- The observation that settled it. In facts.record by definition — a
  -- prediction validated by another prediction validates nothing, and the
  -- check below is what stops that being a matter of discipline.
  observation   uuid not null,

  -- What reality said. Not a score and not a correction to the inference:
  -- a reading of how the prediction stood up, recorded beside it.
  verdict       text not null,

  -- Free text, and often the most valuable column here. "Harvest was late
  -- because the rains were" is the sort of thing that explains a model's
  -- failure and that no metric captures.
  note          text null,

  linked_at     timestamptz not null,
  linked_by     uuid not null,
  dataset       text not null default 'live',
  recorded_at   timestamptz not null default now(),

  constraint validation_verdict_known check (verdict in (
    'confirmed',      -- the observation fell inside what was predicted
    'contradicted',   -- it fell outside
    'inconclusive'    -- it happened, and does not settle the question
  )),

  constraint validation_dataset_known check (dataset in ('live', 'seed')),

  -- One link per pair. Re-submitting is a no-op rather than a second row, so
  -- an evaluation set cannot be padded by replaying the same link.
  constraint validation_once unique (inference_id, observation)
);

comment on table inference.validation is
  'Spec §6.3. Observations that later settled a prediction. The prediction '
  'acquires a verdict and never becomes a fact.';

comment on column inference.validation.observation is
  'Must exist in facts.record. Enforced by kernel.validation_observation_is_fact().';

create index validation_by_inference on inference.validation (inference_id);
create index validation_by_observation on inference.validation (observation);

-- ── the observation really is an observation ──────────────────────────────
--
-- Not a foreign key: facts.record is partitioned on recorded_at and its
-- primary key is (id, recorded_at), so there is nothing single-column to
-- reference. A trigger is the honest equivalent and can say why it refused.

create or replace function kernel.validation_observation_is_fact()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from kernel.record_key
     where id = new.observation and record_class = 'observation'
  ) then
    raise exception
      'validation % names %, which is not an observation', new.id, new.observation
      using errcode = 'foreign_key_violation',
            hint = 'A prediction validated by another prediction validates '
                   'nothing. The link must name a record in facts.record.';
  end if;

  if not exists (
    select 1 from kernel.record_key
     where id = new.inference_id and record_class = 'inference'
  ) then
    raise exception
      'validation % names %, which is not an inference', new.id, new.inference_id
      using errcode = 'foreign_key_violation';
  end if;

  return new;
end;
$$;

create trigger validation_observation_is_fact
  before insert on inference.validation
  for each row execute function kernel.validation_observation_is_fact();

-- ── append-only ───────────────────────────────────────────────────────────
--
-- A verdict that could be edited is a verdict that can be improved after the
-- fact, which is the one thing an evaluation dataset must not permit.

create or replace function kernel.validation_append_only() returns trigger
language plpgsql as $$
begin
  raise exception
    'a validation is a record of what reality said; % is refused', tg_op
    using errcode = 'restrict_violation',
          hint = 'A link made in error is withdrawn by a superseding record, '
                 'never by editing the verdict.';
end;
$$;

create trigger validation_append_only
  before update or delete on inference.validation
  for each row execute function kernel.validation_append_only();

grant select, insert on inference.validation to kernel_app;
revoke update, delete, truncate on inference.validation from kernel_app;
