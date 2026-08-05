# Lawful basis and consent

**What it prevents: discovering, after processing a million records, that
nobody can say which law permitted any of it.**

Uganda's Data Protection and Privacy Act requires a lawful ground for
processing. The usual failure is that the ground is a fact about the
organisation — recorded in a policy document, decided once, applied to
everything. Then the policy changes, and there is no way to say what ground a
record collected in 2026 was collected under, because the ground was never
attached to the record.

## Every record states its own ground

`lawful_basis` is on the envelope, mandatory, and part of the record forever.
The permitted values are in the
[Enumerations reference](../reference/enumerations.md):

`consent`, `legal_authorisation`, `public_duty`, `national_security`,
`law_enforcement`, `contract_performance`, `medical`, `legal_obligation`,
`special_data_consent`.

Two carry most of the traffic:

**`contract_performance`** — the cooperative processes a member's details
because there is a membership agreement. Enrolment, plots, plantings, harvests.

**`special_data_consent`** — s.9 treats financial information as special
personal data, which needs explicit consent and cannot ride on contract
performance. Deliveries carry a price, and a price is financial information.

The dry run makes this visible at stage 3:

```text
  the delivery needs s.9(3) consent — contract performance will not carry it
```

A record's basis constrains what can be done with it downstream. A read whose
purpose is not compatible with the record's basis is refused, and the reason
`lawful_basis_forbids` is recorded.

See [0019](../decisions/index.md).

## Consent is a record, not a flag

A grant is an append-only record naming:

- the **subject** granting it,
- the **grantee** it is granted to,
- the **purpose** it covers, such as `credit_assessment`,
- the **record types** it covers,
- when it was granted, and when it expires.

Withdrawal is a further record; nothing is edited. A grant that was revoked
still exists, along with what it permitted while it was live, because "did this
lender have permission on 3 June" is a question somebody will eventually ask.

See [0029](../decisions/index.md).

## Purpose is required, and it is a query parameter

Every read that discloses records must state a purpose:

```text
GET /v1/records?type=delivery&subject=…&purpose=credit_assessment
```

A read with no purpose gets **400 `purpose_required`** and is told so plainly. A
purpose sent as a header gets **400** with a message saying to send it as a
query parameter.

Both of those used to be indistinguishable from having no grant, which meant an
integrator with a typo in a header name spent an afternoon debugging a
permissions problem that did not exist. A purpose is part of *what is being
asked*, not of how the request is transported, so it belongs in the URL.

## Data subjects are natural persons

A delivery names a farmer and a cooperative. The consent gate used to treat both
as data subjects and wait for the cooperative to consent to disclosure of its
own trading activity — so the farmer's grant, given in good faith, achieved
nothing.

The DPPA protects individuals. A cooperative, business, institution or agency is
a **party** to a record but not a data subject. Subject resolution now counts
only parties whose `kind` is `person`. Unknown kind is treated as a person,
matching the redaction default: the safe direction is to over-protect.

A record with **no** natural person on it is not thereby open. It is simply not
the DPPA's business — no individual is protected by refusing it — and what still
gates it is the organisation's own authorisation. A cooperative's lot is its own
to permit; it was never its members' to consent to.

## What a refusal says

Nothing.

```text
404 no such record, or not yours to read
```

No record id, no type, no party id. A 403 naming the record and the party whose
grant was missing **is a disclosure**: it confirms that party exists and asserted
something about something. The reason goes to the audit log, where a question
about a refusal should be answered from.

The exceptions are refusals that leak nothing about who holds what:

| Reason | Status |
|---|---|
| `purpose_required` | 400 |
| `no_verified_subject` | 401 |
| everything else | 404, with no code and no identifiers |

## The reasons recorded

Every decision, allow or deny, is recorded with a reason:
`self_read`, `asserter_read`, `member_body`, `member_body_with_grant`,
`third_party_with_grant`, `kernel_integrity`, `unattributed_record`,
`no_attributable_party`, `subject_unresolvable`, `no_verified_subject`,
`purpose_required`, `no_grant`, `grant_expired`, `grant_revoked`,
`grant_wrong_purpose`, `grant_wrong_record_type`, `financial_needs_consent`,
`lawful_basis_forbids`.

These are what makes a refusal answerable later. The caller gets a 404; the
operator, reading the audit log, gets the reason.

!!! warning "Open, with counsel"

    Whether s.9(3)(c) permits a cooperative to process its members' financial
    information without separate explicit consent is unresolved. The kernel
    currently requires the separate consent — the stricter reading — behind
    `S9_CONSENT_REQUIRED_FOR_MEMBER_BODY`. If counsel says otherwise the flag
    flips; if counsel is never asked, the flag stays as it is.
