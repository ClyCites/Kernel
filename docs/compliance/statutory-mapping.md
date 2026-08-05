# Statutory mapping

Uganda's Data Protection and Privacy Act, 2019. One row per duty: the section,
the mechanism, where it lives, and its state.

Read this page beside [What is not yet true](not-yet-true.md). Neither is
complete without the other.

**State** is one of: **built** — implemented and covered by tests;
**partial** — implemented with a stated gap; **not built** — no mechanism
exists.

## Lawful processing

| Section | Duty | Mechanism | Where | State |
|---|---|---|---|---|
| s.7(1) | Processing needs a lawful basis | `lawful_basis` is mandatory on every record; the enum is the closed list of grounds | `packages/schema` envelope; `facts_lawful_basis_stated` | **partial** — the constraint is `NOT VALID`, so it binds new rows only |
| s.7(2) | Consent must be specific | A grant names grantee, purpose, record types and expiry; all five required | `src/consent` | **built** |
| s.7(3) | Right to object | Objection records, resolved and their effect stored at insert time | `src/consent`, migration `0032` | **built** |
| s.9 | Special personal data | `special_data_consent` required for financial records; `kernel_financial_records_without_special_consent` should be zero | `src/consent`, `/v1/metrics` | **partial** — s.9(3)(c) member-body reliance is with counsel |

## Notice and transparency

| Section | Duty | Mechanism | Where | State |
|---|---|---|---|---|
| s.13(1)(i) | Tell the subject the retention period | Retention notice returned with collection-facing responses | `src/consent` (J5) | **built** |
| s.16(4) | Tell recipients when a record is corrected | Corrections queue a notification per prior disclosure; `kernel_disclosure_notifications_outstanding` counts them | `src/records`, `/v1/metrics` | **partial** — the obligation is tracked; **no channel exists to discharge it** |

## Data minimisation and accuracy

| Section | Duty | Mechanism | Where | State |
|---|---|---|---|---|
| s.18(4) | De-identify where the purpose no longer needs identity | — | — | **not built** |
| s.20(2) | Verify data recurrently | Monthly verification procedure | Runbook §6 | **partial** — written procedure, never executed against real data |

## Security and incidents

| Section | Duty | Mechanism | Where | State |
|---|---|---|---|---|
| s.23 | Notify a breach | Breach procedure with notification steps | Runbook §1 | **partial** — the procedure exists; contact rows are empty and it has never been rehearsed |

## Subject rights

| Section | Duty | Mechanism | Where | State |
|---|---|---|---|---|
| s.24(1) | Access to data held | Subject-access route, keyed to the verified subject; no subject parameter | `src/consent` | **built** |
| s.24(1)(c) | Name who it was disclosed to | Every access-log entry returned, third parties named | `audit` schema | **built** |
| s.24(4) | Withhold parts identifying another individual | Field-level redaction — `asserted_by` withheld, the record still returned | `src/consent` | **built** |
| s.27 | Automated decisions | The kernel makes none: no scores, no ratings, no automated decision path; enforced by a naming invariant test | `test/invariants/naming.test.ts` | **built, by not building** |

## Registration and accountability

| Section | Duty | Mechanism | Where | State |
|---|---|---|---|---|
| s.29 | Register with the PDPO | — | — | **not done** |
| s.36 | Retain records of processing | Append-only store; the audit log is a statutory record in its own right | `audit` schema, ADR 0025 | **built** |
| s.37 | Produce records to the regulator on demand | The audit log is queryable | `audit` schema | **partial** — **no operator tooling to read it.** A duty that requires a hand-written SQL query under time pressure is not discharged |

## What the mapping does not claim

- **Not a legal opinion.** No counsel has reviewed this mapping.
- **Not evidence of compliance.** No real personal data has ever been stored, so
  none of these mechanisms has been exercised against a live subject.
- **Not security assurance.** There has been no penetration test, and the
  verified-subject header is a trust boundary the kernel cannot defend by
  itself — see [The authorisation model](../building/authorisation.md).
- **Not tamper evidence.** No Merkle root has been published. See
  [Anchoring](../flows/anchoring.md).

The relevant decisions are 0019, 0025, 0029, 0030, 0031, 0032 and 0035 —
indexed under [Decisions](../decisions/index.md).
