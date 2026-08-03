# 0015 — `Observation.subject_ref` is checked, not enforced

## Status

Accepted.

## Context

`Observation` carries `subject_type` and `subject_ref`. Nothing in the storage
layer connects them to anything. An observation can name a `subject_ref` that is
a lot when it says `plot`, or a uuid that is nothing at all, and the log accepts
it without comment.

The obvious fix is a foreign key. It does not survive contact with invariant 5.

## What the offline default rules out

An observation routinely arrives before its subject. Two officers, two phones,
two reconnection times, and the moisture reading syncs on Tuesday while the lot
it describes syncs on Thursday. So:

**A real foreign key is impossible.** `subject_ref` would reference
`kernel.record_key`, and out-of-order arrival breaks it on insert. Deferral does
not help — constraints defer to the end of a transaction, not to the end of a
sync window.

**Rejection at ingest is worse than useless.** It discards a valid record for a
reason that stops being true a day later, and P6 says flag, never reject.

**A stored `subject_not_found` flag is the trap decision 0012 already named.**
Quality flags are written once. The same two records syncing in the other order
would carry different flags forever, and an immutable order-dependent flag is a
worse artefact than none.

## The distinction that settles it

Two different questions hide inside "is this subject valid":

| Question | Order-dependent | Where it is answered |
| --- | --- | --- |
| Does the subject exist? | Yes | Read time |
| Is it the kind of thing the observation declared? | **No** | Ingest, stored |
| Has the subject been retracted? | Yes | Read time |

Once a subject is found, whether its type agrees with `subject_type` is settled
forever. Nothing later changes a lot into a plot. That fact is worth writing
down, and it is the one most likely to be an application bug rather than a sync
artefact.

## Decision

**`subject_type_mismatch` is a quality flag, written at ingest, only when the
subject is present and is demonstrably the wrong kind.** Absence produces no
flag.

**Existence, actual type and retraction are resolved on every read** and attached
to the observation's `RecordView` as `subject`, batched one query per page, the
same shape as `custody`, `balance` and `fulfilment`.

`type_matches` is deliberately three-valued. `null` means unknowable — either
the subject has not arrived, or the declared type names nothing the log can
hold. Collapsing that to `false` would report a missing record as an error and a
present one as the same error.

An observation about a **retracted** subject is surfaced, not hidden. It remains
someone's account of what they saw, and the fact that the thing they saw was
later withdrawn is information about both.

## Cost

One indexed lookup on the ingest path per observation. Ingest already reads the
database for supersession, retraction and conversions, so this is not a new
class of cost, but it is a round trip and it should show up first if ingest
latency ever becomes a problem.

## Finding for spec §13: `region` cannot resolve

`SubjectType` includes `region`, but regions are registry rows keyed by code and
vintage. They are not records and have no uuidv7. `subject_ref` is
`z.uuid({ version: "v7" })`, so **a region observation cannot name its own
subject.** There is no value that would satisfy it.

Three ways out, none of which the kernel may choose for itself: regions become
records, `subject_ref` widens to admit a registry key, or `region` comes out of
the enum. Until then `RECORD_TYPE_FOR_SUBJECT['region']` is null and a region
observation resolves to `type_matches: null` rather than being quietly called
broken. There is a test asserting this so the finding cannot be lost.
