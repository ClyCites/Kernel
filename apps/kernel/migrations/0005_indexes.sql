-- 0005 — Indexes.
--
-- Created on the partitioned parents so every current and future partition
-- inherits them.
--
-- The access patterns these serve (brief Phase 1 and Phase 3):
--   asserted_by  — "everything this party claimed"
--   occurred_at  — season and window queries; the common analytic filter
--   type         — "all deliveries"
--   supersedes   — walking a correction chain, and finding forks (spec §8.4)
--   body (GIN)   — subject lookups without a column per entity reference

create index facts_record_asserted_by_idx on facts.record (asserted_by);
create index facts_record_occurred_at_idx on facts.record (occurred_at desc);
create index facts_record_type_idx        on facts.record (type);
create index facts_record_supersedes_idx  on facts.record (supersedes)
  where supersedes is not null;
create index facts_record_body_gin_idx    on facts.record using gin (body jsonb_path_ops);

-- `recorded_at` drives the sync cursor (Phase 6) and partition pruning.
create index facts_record_recorded_at_idx on facts.record (recorded_at);

create index inference_record_asserted_by_idx on inference.record (asserted_by);
create index inference_record_occurred_at_idx on inference.record (occurred_at desc);
create index inference_record_type_idx        on inference.record (type);
create index inference_record_supersedes_idx  on inference.record (supersedes)
  where supersedes is not null;
create index inference_record_body_gin_idx    on inference.record using gin (body jsonb_path_ops);
create index inference_record_recorded_at_idx on inference.record (recorded_at);
