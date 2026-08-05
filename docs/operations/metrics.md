# Metrics

```
GET /v1/metrics
```

Prometheus text. The series are chosen for one purpose: **to surface a
compliance or data-quality problem before somebody discovers it in a dispute.**
Latency and error rates come from the gateway, which already measures them.

## Statutory obligations

| Series | Watch for |
|---|---|
| `kernel_subject_access_requests_total` | s.24 volume |
| `kernel_subject_access_seconds_max` | Approaching the 30-day limit |
| `kernel_subject_access_seconds_sum` | Time to respond, in aggregate |
| `kernel_disclosure_notifications_outstanding` | s.16(4) — corrections whose recipients have not been told |
| `kernel_disclosure_notification_oldest_seconds` | The oldest one; this is a duty with a clock |
| `kernel_records_by_lawful_basis` | s.7 — a basis distribution that shifts unexpectedly |
| `kernel_financial_records_without_special_consent` | **Should be zero.** s.9 |
| `kernel_standing_objections` | s.7(3) — live objections in force |

`kernel_disclosure_notifications_outstanding` will only ever fall when there is
a channel to notify people through. There is not one yet, so this series
measures an accumulating obligation rather than a queue being worked.

## Objection effects

```text
kernel_objections_by_effect{effect="stopped_some"} 1
kernel_objections_by_effect{effect="stopped_nothing_out_of_scope"} 1
```

Five effects: `stopped_some`, `stopped_nothing_no_records`,
`stopped_nothing_out_of_scope`, `stopped_nothing_consent_only`,
`stopped_nothing_exempt`.

**A rising `stopped_nothing_*` count is the signal that matters.** It means
people are exercising a right and achieving nothing — an interface problem
visible at scale and in no test suite. Alert on the ratio, not the total.

## Data quality

| Series | Watch for |
|---|---|
| `kernel_assumed_conversion_share` | The share of quantities normalised with an `assumed_default` factor. Currently effectively 1. |
| `kernel_normalized_kg_total` | Denominator for the above |
| `kernel_thin_sample_kg_total` | Mass normalised by factors derived from too few samples |

These carry the honesty of the whole [quantity](../concepts/quantity.md) story.
If `kernel_assumed_conversion_share` is high, every derived mass in the system
is an assumption, and a lender should be told so.

## Delegation

`kernel_delegations_total` and `kernel_delegated_records_total` exist to settle
[open decision D7](../decisions/index.md) — whether delegation scope belongs per
record type or per field — with field data rather than argument.

## Anchoring

| Series | Meaning |
|---|---|
| `kernel_anchor_configured` | 1 when a publisher is configured. **Currently 0.** |
| `kernel_anchor_root_age_days` | Age of the newest published root |
| `kernel_anchor_unanchored_age_days` | Age of the oldest record with no published root |
| `kernel_anchor_batches_pending` | Roots computed but not published |
| `kernel_anchor_batches_failed` | Publication attempts that failed |
| `kernel_anchor_stale` | 1 when publication has fallen behind |

!!! warning "Do not alert on `kernel_anchor_stale` yet"

    With no publisher configured, `pending` grows by one per day forever and
    `stale` is permanently 1. That is the honest state, not an incident. Wire
    these alerts when [anchoring](../flows/anchoring.md) actually publishes,
    and until then treat `kernel_anchor_configured == 0` as the fact to display
    on a dashboard rather than page on.

## What is not measured

- Nothing per data subject. A metric labelled with a party id is a disclosure
  channel that bypasses every consent gate.
- Nothing per cooperative, for the same reason.
- No content. Counts and ages only.

## Health

`GET /v1/health` is liveness. `GET /v1/ready` checks the database and the object
store; readiness failing is the correct response to an unreachable object store,
because a kernel that accepts writes it cannot store evidence for is worse than
one that is briefly out of rotation.
