# Reading the output

The dry run prints a lot. This is what to look at and what a healthy run looks
like, so that an unhealthy one is obvious.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every stage passed |
| non-zero | A stage failed and said which |

One code is deliberately not a failure and not a success:

| Code | Where | Meaning |
|---|---|---|
| `3` | `anchor-cli`, `restore.sh` | Computed but unpublished; verified but deferred |

A root that was computed and not published is genuinely neither success nor
failure, and collapsing it into either would be a lie in one direction or the
other. The same applies to a restore that verified the database and could not
reach the object store.

## What a healthy run looks like

```text
  applied: 32 migrations
      facts.record           INSERT, SELECT
  ready: {"status":"ready","schema_version":"0.3.0"}
```

Then, stage by stage, the four things worth checking:

**Stage 4** — `independent true`. If this reads `false`, the confirmation came
from a delegate rather than the counterparty and is weaker evidence. Both are
valid; only one is independent.

**Stage 5** — one `200 disclosed` and one `404 no such record, or not yours to
read`. A 403 appearing here is a regression: refusals must name nothing.

**Stage 7** — `external verification: INCOMPLETE — see stage 7 above.
Reportable.` This is the expected result today. It becomes a real verification
only when a root is published. If it ever reads complete without anyone having
created a topic, something is wrong with the verifier, not right with the
system.

**Stage 10** — `restore: verified — N manifest lines match`, then `the evidence
photograph still resolves after restore`. The manifest line count changes as
migrations add tables; the requirement is that the two counts match each other,
not that they equal any particular number.

## Timings

A run on a 2026 laptop takes about fifteen seconds:

| Stage | Time |
|---|---|
| 1 — stand up | 10s |
| 2 — enrol | 0.15s |
| 3 — record | 0.30s |
| 4 — confirm | 0.10s |
| 5 — disclose | 0.04s |
| 6 — correct | 0.14s |
| 7 — anchor | 1s |
| 8 — subject access | 0.03s |
| 9 — object | 0.05s |
| 10 — back up and restore | 3s |
| 11 — the lender view | 0.15s |

Stage 1 dominates because it starts two containers from empty volumes. Nothing
after it should take longer than a few seconds; if a stage does, the kernel log
at `tmp/dry-run/kernel.log` is the place to look.

## Findings

Some stages print a block headed **FINDING, reported not patched**. These are
real and deliberate. The dry run is not a demonstration that everything works —
it is an instrument, and an instrument that only ever reports success is not
measuring anything.

The current one is in stage 9: objection scope is matched against record types,
while a data subject reasons in purposes. Lodging `credit_assessment` is
technically accurate and stops nothing.

Findings surfaced by earlier runs and since fixed are visible in the narration
as "this used to…" — stage 4's one-sided confirmation, stage 5's two-subject
consent gate and its 403, stage 9's silent objection, stage 10's backup that
exited 0 having skipped every photograph.

## Artefacts

| Path | What it is |
|---|---|
| `tmp/dry-run/kernel.log` | The kernel's own log for the run |
| `tmp/dry-run/backups/<stamp>/` | The encrypted dump, manifest, object inventory and checksums |
| `tmp/dry-run/objects-before.txt` | The object inventory taken before the dump |

None of these should be committed. They are ignored, and the pre-commit secret
scan will object to some of them regardless.
