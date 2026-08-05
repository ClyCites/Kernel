# The quantity problem

**What it prevents: discovering that a conversion factor was wrong and having
no way to recompute, because the original observation was overwritten by the
converted one.**

## A bag is not a unit

A farmer sells "twelve bags" — *kaveera*. A bag is not a defined quantity. It
varies by region, by crop, by season, by whether it was filled generously, and
by which trader is doing the filling. Somewhere between 90 kg and 120 kg is
normal for maize, and both ends of that range are honest.

The naive design stores `weight_kg: 1416` and moves on. Six months later
somebody weighs bags in that district properly and finds the factor was 98 kg,
not 118. Every derived figure in the system is now wrong, and there is no way to
fix any of it, because the twelve is gone.

## What is stored instead

Every quantity keeps all of:

| Field | Example | Why |
|---|---|---|
| `raw_value` | `12` | What was actually observed |
| `raw_unit` | `bag` | The unit class |
| `raw_unit_label` | `kaveera` | The word the farmer used |
| `normalized_kg` | `1416` | The derived figure |
| `conversion_id` | `019fc600…0020` | Which factor was applied |
| `measurement_method` | `coop_weighed` | How it was arrived at |

The invariant enforced by the schema: **`normalized_kg` requires
`conversion_id`.** A kilogram figure that cannot say where it came from is
refused, because it is exactly the figure nobody can recheck. Kilograms need no
conversion and carry none.

When the factor turns out to be wrong, the registry supersedes it, and every
record that cited it can be recomputed from the twelve that is still there.

`raw_unit_label` exists so the farmer's own word survives. It has no
computational use. It matters when somebody goes to that district and asks what
a *kaveera* is, and needs to be asking about the same thing.

## The registry is public and unauthenticated

`GET /v1/registry/**` takes no subject header and passes no consent gate. It
serves conversions, crop codes, administrative boundaries and grading
vocabularies — data with no data subject.

This is deliberate and it is the load-bearing part. A delivery cites a
`conversion_id`. If resolving that id required a credential, then **verifying a
weight would require our permission**, and a record you need our permission to
verify is a record you are trusting us for. The entire point is that you should
not have to.

A conversion resolves to the individual weighings behind it: who took them, when,
on what, and how many. See [0024](../decisions/index.md) and
[0018](../decisions/index.md).

## Every factor today is assumed

!!! danger "Not one conversion factor has been measured"

    Every row in the conversion registry is `assumed_default` or synthesised
    from published sources. None comes from somebody weighing bags in a store
    with a calibrated scale.

    This is why `/v1/metrics` publishes the share of normalised mass resting on
    an unverified factor. **It reads high, and that is the point** — a metric
    that reported comfortably would be hiding the largest known weakness in the
    data.

Getting real factors requires field work, which is one of the four open
decisions that need cooperative visits rather than more code.

## The flags this produces

| Flag | When |
|---|---|
| `quantity_not_normalized` | No kilogram figure was derived; the raw count stands alone |
| `conversion_unresolved` | The cited factor is not in the registry, or none was cited |
| `conversion_mismatch` | Raw × factor ≠ the stated kilograms — the record kept both |
| `conversion_scope_mismatch` | The factor was registered for a different commodity or district |
| `region_unresolvable` | The factor is district-specific and the record does not say which district |

`conversion_mismatch` deserves attention: the record disagrees with itself and
**both halves are kept**. Recomputing silently would destroy the evidence that
somebody's arithmetic or somebody's scale is wrong.

`region_unresolvable` is the honest one. It does not say the factor is wrong; it
says whether it applies cannot be determined either way. A flag that admits
ignorance is more useful than one that guesses.

## Mass balance

A lot that released more than it took in, after declared losses, is flagged
`mass_balance_discrepancy`. The tolerance is a named constant, and the
[lender report](../flows/read-path.md) prints it — "discrepancy" without the
threshold it exceeded is an accusation with no scale.

See [0014](../decisions/index.md).
