-- 0007 — Retraction lookup.
--
-- Spec §8.1: a retracted record stays in the log and is excluded from every
-- default read. That exclusion is on the hot path of every read, so finding
-- "is there a retraction targeting this id" must be an index lookup.

create index facts_record_retraction_target_idx
  on facts.record ((body ->> 'target'))
  where type = 'retraction';
