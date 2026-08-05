# The inference quarantine

**What it prevents: a model trained on its own output, which degrades while its
confidence does not.**

## The failure mode

A yield model predicts 1,380 kg for a plot. The prediction is written to the
records table because it is convenient to have it beside the observations. Next
season, the training set is rebuilt from the records table. The model now learns
from its own guesses.

Nothing breaks. No error is raised. The model's confidence scores stay healthy —
they measure agreement with the training data, and the training data is now the
model. The degradation is invisible from inside the system and shows up
eventually as a lending book that does not perform.

This is not a hypothetical risk in an agricultural data platform; it is the
default outcome unless something structural prevents it.

## The quarantine

Observations and inferences are separated at every level that could be crossed:

| | Observations | Inferences |
|---|---|---|
| Postgres schema | `facts` | `inference` |
| Table | `facts.record` | `inference.record` |
| Endpoint | `GET /v1/records` | `GET /v1/inferences/{id}` |
| `record_class` | `observation` | `inference` |

`record_class` is a **pinned literal on each entity schema**, not a field an
application sets. A `Harvest` cannot be parsed with `record_class: "inference"`,
and an `Inference` cannot be parsed with `record_class: "observation"`. The
schema refuses both directions, and tests assert both.

## Inferences are not listable

There is no `GET /v1/inferences` returning a page of predictions. An inference
is reachable **only by asking for it by name**, with an id you already have.

The reason is that a listable prediction table becomes a data source. Someone
builds a report against it, the report is useful, and within a quarter model
output is flowing into decisions that were specified against observations. A
route that cannot be enumerated cannot be swept into a pipeline by accident.

## What an inference must carry

- `model_id` and `model_version` — which model, which version. A prediction
  whose model cannot be identified cannot be withdrawn when that model is found
  to be wrong.
- `inputs` — **every** record it was computed from, by id. An inference that
  cannot name its inputs is not reproducible, and the schema refuses one with an
  empty list.
- `confidence` — the model's own figure, kept as the model's claim rather than
  as a property of the world.
- `inference_depth` — how many inferences deep this is.

## Depth is flagged

`inference_depth` above 1 is flagged. An inference computed from another
inference is the chain that produces confident nonsense, and while there are
legitimate uses, none of them should happen without somebody noticing.

## Training eligibility is a function, not a filter

`isTrainingEligible` returns true only for `record_class: "observation"`. It is
a single function with a test, so the rule lives in one place rather than being
re-implemented as a `WHERE` clause in each training pipeline — where one
omission silently reintroduces the whole problem.

Beyond that, a dedicated database role governs training reads, so the separation
is a permission and not only a convention.

See [0036](../decisions/index.md).

## What is out of scope

The kernel does not run models. There is no inference engine here, no scoring,
no pricing. It holds the outputs, keeps them apart from observations, and
records what they were computed from. Anything that produces a prediction is an
application, reaching the kernel through the same public API as everything else.
