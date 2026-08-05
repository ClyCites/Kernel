# Subject access and objection

**What it prevents: a data subject exercising a right and being told nothing
about what it achieved.**

## Subject access — s.24

A data subject is entitled to know what is held about them **and who has looked
at it**. The second half is the one systems usually cannot answer, because
nothing recorded the reads.

```text
  due_by  2026-09-04T11:06:17.908Z  (30 days out)
  access log: 12 entries, of which 2 a disclosure to somebody else
    the lender is 019fd19a…3a44 — named above, as s.24(1)(c) requires.

  records held about the farmer: 5
    delivery   019fd19a…5091  basis special_data_consent  redacted: asserted_by
```

The response carries a **due-by date**, thirty days out, because the statutory
clock starts when the request is made and a system that does not track it will
miss it.

All twelve access entries are returned, not only the interesting two. The other
ten are the cooperative reading its own records and the officer reading what he
asserted. The subject is entitled to know every touch.

The route takes no subject parameter — you are the subject, established by the
verified identity on the request. A route where you name whose data you want is
a route somebody will eventually call with somebody else's name. See
[0031](../decisions/index.md).

### Redaction under s.24(4)

A delivery names two people. Disclosing the whole record to one of them
discloses the other.

s.24(4) withholds **the part that identifies another individual**, rather than
refusing the whole record. So the delivery comes back with `asserted_by`
withheld and everything else intact — the subject learns what is held about her
without learning who the counterparty was.

The line drawn here is the same one drawn in the consent gate: `PartyKind`
distinguishes a natural person from a cooperative, business, institution or
agency. Only a natural person is a data subject; unknown kind is treated as a
person, because the safe direction is to over-protect.

## Objection — s.7(3)

Objection and withdrawal are **not the same right**, and conflating them is what
made the previous behaviour dishonest.

| | Withdrawal | Objection |
|---|---|---|
| Reaches | Processing done on your consent | Processing done *without* asking you |
| Under | The grant you gave | s.7(3) |
| Effect | The grant stops | Depends what the processing rested on |

A farmer whose records are processed under `special_data_consent` — because she
granted it — presses "I object". Legally, s.7(3) reaches nothing: the processing
is consensual, and consent ends by withdrawal.

Previously she got a correct, unhelpful answer: two accurate lists and no
statement of what had happened.

### What it says now

```text
  what the kernel said back to her:
    This objection stops disclosure of 2 record(s) to others.
    effect recorded, and counted on /metrics: stopped_some
```

and, for one that reaches nothing:

```text
    Nothing stopped. This processing runs on your consent, and consent ends
    by withdrawal, not by objection — s.7(3) only reaches processing done
    without asking you. Withdraw the grants listed below and it stops.
```

Three things, always: **nothing stopped**, **why**, and **the grants you can
withdraw instead** — each named. Offering the action that works beats reporting
that the requested one did not.

### The effect is recorded, at insert time

Every objection stores what it achieved:

`stopped_some` · `stopped_nothing_no_records` ·
`stopped_nothing_out_of_scope` · `stopped_nothing_consent_only` ·
`stopped_nothing_exempt`

and `/metrics` publishes the counts:

```text
# HELP kernel_objections_by_effect Objections lodged under s.7(3) by what they actually stopped.
kernel_objections_by_effect{effect="stopped_nothing_out_of_scope"} 1
```

**A rising count of objections that stop nothing means the interface is
misleading people at scale.** That is a product signal that no test would ever
produce.

!!! note "A finding from building this"

    The first implementation resolved the objection, inserted it, then filled
    the effect column with an `UPDATE`. The application role refused:
    `permission denied for table objection`.

    That is [invariant 1](../concepts/append-only.md) working. A column
    recording what a subject was told is exactly the kind of thing that must not
    be editable afterwards. The service now resolves before it inserts and
    writes the row complete.

### What an objection stops, and what it does not

```text
  what stopped:
    the lender's credit_assessment read  404 — refused

  what continues, and on what ground:
    the coop's own read  200 — the coop is a subject of this record, not a
      third party to it. An objection does not stop the other side of a
      transaction holding its own copy of it.

  the subject's own access is unaffected:
    subject access  200 — s.24 is not a consent-based right.
```

## Open finding: scope is a record type

!!! warning "Reported, not patched"

    Objection scope is matched against **record types**, because that is what
    the field means. A farmer objecting does not think in record types — she
    thinks *"stop using my information for credit assessment"*, which is a
    **purpose**.

    Lodging the purpose she means returns `stopped_nothing_out_of_scope`:
    technically accurate, and it stops nothing, because no record is of type
    `credit_assessment`.

    Whether objection scope should be purposes, record types, or both is a
    decision, not a bug.

This is the fourth instance of one class of problem: **the kernel is legally
correct and behaves in a way the person it protects would not predict.** That
gap does not show up in a test suite. It shows up when somebody watches a farmer
use the thing.

## Not built

- **Erasure** under s.16/s.18. Open decision D3, with counsel. An erased
  record's leaf hash would already be published, so the salt must be deleted as
  part of erasure.
- **Notifying parties when an objection is lodged.** s.16(4) reaches
  corrections, not objections, so there is no statutory hook — and no channel
  either way.

See [0030](../decisions/index.md) and [0031](../decisions/index.md).
