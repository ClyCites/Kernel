-- 0011 — The dataset discriminator.
--
-- Append-only means no DELETE. Fabricated records generated for testing or
-- demonstration are therefore permanent, and without a way to tell them from
-- real ones they would eventually be counted in metrics, returned to
-- applications, and anchored into a published Merkle root — which publishes
-- invented farmer records irreversibly to a public ledger.
--
-- The alternative was a seed generator that refuses to run against a database
-- holding real records. That is simpler, and it is wrong here: work orders E, F
-- and I all assume long-lived environments where both kinds coexist — staging
-- is specified as production configuration seeded with `dataset: 'seed'` data,
-- the audit log records `dataset` per entry, and anchoring is specified as
-- `dataset: 'live'` only. A guard that keeps them apart at the row level is the
-- only thing that satisfies all three.
--
-- This is storage-layer plumbing. It is deliberately NOT an envelope field:
-- @clycites/schema describes what a record asserts about the world, and which
-- corpus a row belongs to is not a claim anybody is making. See
-- docs/decisions/0017-dataset-discriminator.md.

alter table facts.record
  add column dataset text not null default 'live';

alter table facts.record
  add constraint facts_dataset_known check (dataset in ('live', 'seed'));

alter table inference.record
  add column dataset text not null default 'live';

alter table inference.record
  add constraint inference_dataset_known check (dataset in ('live', 'seed'));

-- Carried here too so "does this database already hold real records" is one
-- cheap query against one unpartitioned table, and so the anchoring guard can
-- check an id without knowing which namespace it lives in.
alter table kernel.record_key
  add column dataset text not null default 'live';

alter table kernel.record_key
  add constraint record_key_dataset_known check (dataset in ('live', 'seed'));

-- Partial, because `live` is almost every row and an index on it would never be
-- chosen. The selective direction is "show me the seed corpus", which the seed's
-- own verification and any cleanup tooling ask constantly.
create index record_non_live on facts.record (dataset)
  where dataset <> 'live';

create index inference_record_non_live on inference.record (dataset)
  where dataset <> 'live';

create index record_key_non_live on kernel.record_key (dataset)
  where dataset <> 'live';

comment on column facts.record.dataset is
  'Which corpus this row belongs to. Never anchor anything but live.';
