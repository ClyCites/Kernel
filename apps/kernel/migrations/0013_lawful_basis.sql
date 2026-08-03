-- 0013 — The lawful basis a record was collected under.
--
-- DPPA s.7(3): where a data subject objects, processing must stop — "except for
-- data collected or processed under subsection (2)". So whether a farmer can
-- stop us processing a record depends entirely on the ground relied on when it
-- was collected. Not on what we would claim afterwards, and not on a policy
-- setting that can be changed later.
--
-- This log is append-only. A record ingested today without a basis can never
-- acquire one, and an objection against it can never be answered correctly.
-- That is why this lands before the seed rather than after it.
--
-- The enum is s.7(1), the eight limbs of s.7(2), and s.9(3)(b). It is stored
-- here rather than in @clycites/schema for the same reason `dataset` is: it is
-- read-only, and this is a candidate for promotion to the envelope in v0.3 once
-- counsel confirms the values.
--
-- See docs/decisions/0019-lawful-basis.md.

alter table facts.record     add column lawful_basis text;
alter table inference.record add column lawful_basis text;

alter table facts.record
  add constraint facts_lawful_basis_known check (
    lawful_basis in (
      'consent',               -- s.7(1)
      'legal_authorisation',   -- s.7(2)(a)
      'public_duty',           -- s.7(2)(b)(i)
      'national_security',     -- s.7(2)(b)(ii)
      'law_enforcement',       -- s.7(2)(b)(iii)
      'contract_performance',  -- s.7(2)(c)
      'medical',               -- s.7(2)(d)
      'legal_obligation',      -- s.7(2)(e)
      'special_data_consent'   -- s.9(3)(b)
    )
  );

alter table inference.record
  add constraint inference_lawful_basis_known check (
    lawful_basis in (
      'consent', 'legal_authorisation', 'public_duty', 'national_security',
      'law_enforcement', 'contract_performance', 'medical', 'legal_obligation',
      'special_data_consent'
    )
  );

-- NOT VALID, which is the whole design of this migration.
--
-- The column has no default, exactly like `occurred_at_precision`: a record
-- whose basis cannot be stated does not belong in the kernel. But records
-- already in the log predate the requirement and there is no honest value to
-- backfill them with — writing 'consent' would assert a consent nobody
-- obtained, which is the precise failure this column exists to prevent, and
-- append-only means that lie could never be corrected.
--
-- NOT VALID enforces the constraint on every insert from now on while leaving
-- the pre-existing rows unchecked. Their NULL is the truthful answer: no basis
-- was stated, because none could be.
alter table facts.record
  add constraint facts_lawful_basis_stated check (lawful_basis is not null)
  not valid;

alter table inference.record
  add constraint inference_lawful_basis_stated check (lawful_basis is not null)
  not valid;

create index record_lawful_basis on facts.record (lawful_basis);

comment on column facts.record.lawful_basis is
  'DPPA s.7/s.9 ground relied on at collection. Decides whether s.7(3) objection stops processing.';
