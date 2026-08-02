-- 0002 — Namespaces.
--
-- Invariant 2 (brief §4): observations and inferences never mix. They live in
-- separate Postgres schemas, not behind a boolean column, so that a default
-- read cannot accidentally include a model output. Spec §6.2 rule 1.
--
--   facts      — what the world did. The fact log.
--   inference  — what a model thinks. Quarantined. Never in a default read.
--   kernel     — the kernel's own operational tables. Holds no core records.

create schema if not exists facts;
create schema if not exists inference;
create schema if not exists kernel;

comment on schema facts is
  'Observation-class records. The append-only fact log.';
comment on schema inference is
  'Inference-class records (spec §6). Read only when asked for explicitly.';
comment on schema kernel is
  'Kernel operational tables. Never contains core facts.';
