# What you cannot do

Every constraint here has a reason. A constraint whose reason is invisible gets
treated as an oversight and worked around — usually by the person with the
tightest deadline, at the moment the reason matters most.

---

## You cannot reach past the public API

Not the database, not a kernel module, not a shared library that happens to know
the table names. `/v1` is the entire surface.

**Why.** It is the one thing that lets the schema change without seven
applications breaking. Every direct database read is a copy of the schema
embedded in another codebase, and there is no way to find them all when a column
moves. This is the invariant most likely to be argued with, and the one whose
breach is least visible until it is expensive.

---

## You cannot export in bulk

There is no route that returns everything. Reads are filtered, paged, and pass a
consent gate per record. A test in `test/ops/` asserts that no route resembling
a bulk export exists.

**Why.** A bulk export is a consent gate applied once to an unbounded set, and
the resulting file has no gate at all. Every subsequent copy of it is
processing nobody consented to, in a place nobody is auditing. Cursor pull for
offline sync is scoped to what the device is entitled to; it is not an export.

---

## You cannot hold funds

No `wallet`, no `balance`, no `ledger`, no `FundsHeld`, no `AccountBalance`. A
test asserts those names do not exist in the schema.

**Why.** Holding customer funds makes this a financial institution, with the
licensing, capital and supervision that follows. Obligations are *recorded* and
settlements are *referenced* — `settlement_reference` points at a payment that
happened on a rail somebody else operates. The money moves elsewhere.

---

## You cannot compute a credit score here

Not a score, not a rating, not a risk grade, not a creditworthiness assessment.
A naming invariant test scans the codebase and fails on `credit score`,
`credit rating`, `creditworthiness` and `risk score` in any spacing or casing.

**Why.** Two reasons. A score is a judgement, and judgements belong to whoever
carries the risk of being wrong — a lender, who must be able to explain a
decline. And a score computed in the kernel would be an inference stored beside
observations, which is exactly what the
[quarantine](../concepts/inference-quarantine.md) exists to prevent.

The kernel supplies the evidence and its flags. What that is worth is somebody
else's decision, made in the open, under their own regulator.

---

## You cannot write to the inference namespace

Applications write observations. `inference.record` is not reachable from
`POST /v1/records`, and `record_class` is a pinned literal per entity rather
than a field you set.

**Why.** The moment an application can write an inference, model output enters
the fact log with a plausible provenance envelope. The separation has to be
structural because the pressure to blur it is constant and always well-meant.

---

## You cannot list inferences

`GET /v1/inferences/{id}` only. There is no page of predictions.

**Why.** A listable prediction table becomes a data source. Somebody builds a
report, the report is useful, and model output is in production decisions within
a quarter. A route that cannot be enumerated cannot be swept into a pipeline by
accident.

---

## You cannot update or delete a record

Not through the API and not through the database, as the application role. A
correction is a new record that supersedes; a retraction hides without removing.

**Why.** [Append-only](../concepts/append-only.md). And note what that costs
you: there is currently **no erasure**, which is a real statutory gap and not a
feature. It is open decision D3.

---

## You cannot set a record's flags

Quality flags are derived by the kernel at ingest. You cannot assert them and
you cannot suppress them.

**Why.** A flag an application controls is a flag that gets turned off in the
integration that most needs it.

---

## You cannot decide what a lender sees

The lender report is rendered by the kernel. An application does not assemble it
from raw records.

**Why.** That judgement — no uuids, the tolerance printed, a glossary entry for
every flag, an "as at" date — used to live nowhere, and the artefact a credit
officer actually received was a JSON dump with party ids and `ext: {}`. Rules
that live in one renderer can be reviewed; rules re-implemented per application
cannot.

---

## You cannot use FAO-derived yields in commercial promotion

The licence bars it. A `demo` profile exists so promotional material can be
built without them.

**Why.** Relying on somebody remembering a licence restriction at the moment
they build a slide is not a control. See [Data sources](../data-sources.md).

---

## You cannot send a purpose as a header

`x-clycites-purpose` returns 400 telling you to use `?purpose=`.

**Why.** It used to be silently ignored, which produced a 403 that looked like a
consent problem. An explicit error costs an integrator one minute; the silent
version cost an afternoon.
