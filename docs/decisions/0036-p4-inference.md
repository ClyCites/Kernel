# 0036 — P4: the inference module closed

Status: accepted. 2026-08-04.

## What changed

There is now a write path for inferences. Until this work order there was
none — `POST /v1/records` dispatches on the entity name and `factRecord` pins
`record_class` to observation, so a model output could be described by the
schema package and stored by the repository but could not be submitted by
anybody. The seed recorded that as fixture 12, asserted refused, with a note
saying the assertion would fail loudly when the path landed. It has.

Four things, in the order the work order names them.

### `validated_by`, resolved rather than stored

`inference.validation` (migration 0027) is a row per (prediction, observation)
pair, carrying a verdict of `confirmed`, `contradicted` or `inconclusive`,
who linked it and when. `validated_by` on the record is derived from it on
read, exactly as `superseded_by` is, and a submitted value is discarded on
ingest.

It could not have been stored. The observation that settles a March forecast
arrives in August and the log is append-only, so a stored array would be
permanently empty. What is being recorded is not part of the claim the model
made; it is what reality later said about it.

The prediction acquires a verdict and stays a prediction. There is no path
from `inference.validation` into `facts.record`, and a test asserts the
absence rather than describing it. A forecast that became a fact by turning
out roughly right is precisely the contamination the two schemas exist to
prevent.

The linkage is idempotent on the pair. Re-linking with a different verdict
returns the verdict already recorded. An evaluation set that could be revised
by replaying a request is not evidence of anything.

A validator must be an observation. That is enforced by a trigger against
`kernel.record_key` rather than a foreign key, because `facts.record` is
partitioned on `recorded_at` and its primary key is therefore
`(id, recorded_at)` — there is nothing for a single-column reference to point
at.

### Depth computed server-side

`inference_depth` is now `1 + max(depth of inputs)`, computed from the corpus.
Every input an observation gives 0. Anything above
`MAX_RECOMMENDED_INFERENCE_DEPTH` (1) is flagged
`inference_depth_exceeded` — flagged, per P6, not refused.

Three details worth stating:

A client value is never trusted, and a client value that disagrees with the
computed one is itself flagged, `inference_depth_misstated`. That is not
pedantry. A client whose arithmetic is wrong usually does not know what its own
inputs are, and that is worth surfacing while it is still cheap.

An input not in the corpus contributes 0 and is named separately,
`inference_input_unresolved`. Silently treating an absent input as an
observation would be the wrong guess: the commonest reason for absence is that
it is an inference in a different dataset.

`stale` and `validated_by` are stripped before validation rather than checked
afterwards, so there is no branch in which a client value survives.

### Stale propagation — confirm only

Already built. `DEPENDENCY_FIELDS` in `src/records/staleness.ts` has been
`['inputs', 'validated_by']` since work order L, and
`test/records/lineage.test.ts` already asserted that a retracted validator
makes the verdict stale. What was missing was anything to read: `validated_by`
was always empty. There is now a test that walks the whole path — write a
prediction, link the observation that settled it, retract the observation, read
the prediction stale with the validator named.

Nothing was added to `DEPENDENCY_FIELDS`.

### The training guard

A role, not a filter. `kernel_training` (migration 0028) holds SELECT on
`facts.record` and nothing else: no privileges on the `inference` schema, and
none on `kernel.record_key` either, which spans both namespaces and would
enumerate every prediction in the system by id.

`TrainingRepository` connects through its own pool, provided under its own
token, in a module that imports nothing from `src/inference`. A query that
named a prediction would fail with insufficient privilege before returning a
row, and there are tests for exactly that, asserting the SQLSTATE rather than
the message.

The separation is enforced twice over on purpose. The grants are the control
that actually holds but are invisible in a pull request; the module boundary is
visible but is one line away from being changed. Neither alone is enough.

`TRAINING_DATABASE_URL` unset yields a null pool and every training query
fails. That is the safe direction: an instance not configured for training
should serve nothing rather than fall back to the app connection, which can
read predictions.

## FINDING — nothing named an inference, so every read of one was denied

`PARTY_SUBJECT_FIELDS` and `SUBJECT_FIELDS` had no entry for `inference`, so
the consent guard resolved no subject and denied with `unattributed_record`.
Not a decision anybody took — the record class had no write path, so nothing
ever reached the guard and the gap could not show up.

Fixed by giving `inference` the same one hop an observation has:
`subject_ref`, and no further. A yield prediction about a plot reaches the
plot's holder; one about a party reaches the party. Deliberately not more than
one hop — a prediction should not widen who may see something beyond the
records it was derived from.

## FINDING — the seed fixture carried a value the kernel now discards

Fixture 12 submitted `validated_by` and `inference_depth` in the body. Both are
kernel-derived, so the seed now states the linkage the way a client has to,
through `POST /v1/inferences/{id}/validations`, as a second request after the
records exist. `SeedPlan.validations` carries them and `writeValidations` posts
them last.

The duplicated comment block above the fixture — the same ten lines twice, a
copy-paste artefact — is gone.

## Not in this work order

The read path derives `validated_by` for a single inference. Lists do not
return inferences at all, so there is no batch path and none was built.

Whether `stale` should be written into the inference body the way
`Lot.custodian` is remains open (0022). Nothing here settles it.
