# 0029 — Consent

Status: accepted. Supersedes the stub recorded in 0004.

## The decision

Every disclosure of personal data goes through one function,
`ConsentService.decide`, and that function asks **what kind of access is this**
before it asks whether a grant exists.

Four classes:

| Class | Condition | Needs a grant? |
| --- | --- | --- |
| Self | the requester is a party to the record | no |
| Asserter | the requester stated the record | no |
| Member body | the requester is an organisation the record's parties hold an active membership in — any one of them if it is itself a party, all of them if it is not | only for financial records, and only while the flag below stands |
| Third party | everything else | always |

Member body is the class that unblocks the applications. It maps onto
s.9(3)(c) of the Data Protection and Privacy Act: a body relating to
individuals who are its members, provided there is no disclosure to a third
party without consent. That proviso is not an extra rule bolted on; it is the
architecture, because member-body status belongs to the requester and there is
only ever one requester.

## Two constraints that are not negotiable

**Membership is derived from the record, never from the request.** A caller
that could assert "I am their cooperative" would have a bypass rather than a
gate. `ConsentRepository.activeMemberships` resolves it from `facts.record`, at
the record's `occurred_at`, respecting `left_at` and ignoring superseded and
retracted memberships. At `occurred_at` and not at now, because a farmer's
deliveries three seasons ago remain valid history after they leave — and
because the converse must hold too: a cooperative cannot reach into a past
season by enrolling somebody today.

**Member body does not transit.** A cooperative reading a member's delivery is
member body. The same cooperative passing that to a lender is third party, and
the cooperative's access does not carry the lender along. This is the obvious
exploit and `test/consent/consent.test.ts` tests it by name.

## Classification order

`asserter → member_body → self → third_party`. This is deliberately not the
order of permissiveness.

Asserter comes first because you cannot withhold a record from the party that
wrote it. One consequence is worth stating: in the seed, deliveries are
asserted by a cooperative *officer's* party id under delegation, not by the
cooperative itself, so the cooperative still falls to member body and the flag
below still bites.

Member body comes before self because an organisation reading a record it is
merely a counterparty to is exactly the case s.9(3)(c) governs. Letting `self`
swallow it would make the flag inert. A farmer reading their own priced
delivery is still `self`, because no subject of it holds a membership in the
farmer.

## Who a record is about, when it says so only indirectly

Planting, Harvest and Observation carry no party field. Taken literally that
makes a farmer a third party to their own harvest, which is the opposite of
why the platform exists, and it empties Farm Intelligence — the app reads those
three types and nothing else.

So classification resolves subjects transitively, with two bounds.

**One hop, declared per type.** `PARTY_HOP_FIELDS` in
`src/records/subjects.ts`: Planting and Harvest through `plot`, Observation
through `subject_ref`. The record reached is read for its own party fields and
its own hop is not followed. An open graph walk would be both a performance
problem and a disclosure surface, since every extra edge widens who counts as
a party without anyone having decided that it should. The whole page resolves
in one query.

**Unresolvable denies, visibly.** Where the hop names no record — an
observation of a region, whose `subject_ref` can name none by construction, or
a plot that has not synced yet — the read is refused with `subject_unresolvable`
rather than falling through to third party. Not knowing who a record is about
is not permission to release it, and the reason has to read differently from a
refusal that was actually decided. Asserter is checked first, so the party that
wrote the record still gets it back.

The non-party member-body branch is the other half of this. A cooperative is
not a party to its member's harvest at all, so it reaches one only through
membership — and then only where **every** party the record resolves to is its
member at `occurred_at`. Otherwise reading a member's data would carry an
outsider's along with it, and a coop would acquire a view of its members'
dealings with everyone else. s.9(3)(c) is about processing members'
information, not about everyone they trade with.

## The flag

`S9_CONSENT_REQUIRED_FOR_MEMBER_BODY`, defaulting to **true**.

When true, member-body access to a record carrying financial information — a
priced Delivery, an Obligation, a SettlementReference — additionally requires a
grant. When false, the member-body class alone suffices.

**This is the entire s.9 question and it is the only place in the kernel that
branches on it.** Nothing else in the consent module, the read path or the sync
path consults s.9. If counsel holds that s.9(3)(c) covers a cooperative
processing its members' financial data, flip it. If not, cooperatives collect
consent at enrolment, which they would be doing anyway.

**Fail closed. Default true. Do not flip it without a written answer.**

The counsel question is narrow enough to answer yes or no: *does s.9(3)(c)
permit a cooperative to process its members' financial information without
separate explicit consent?*

Non-financial records — Plot, Planting, Harvest, Observation, Lot,
CustodyTransfer — are unaffected either way, which is already most of what Farm
Intelligence and Supply Chain need.

## Grants

`kernel.consent_grant` is an append-only kernel-side table, following the
`dataset` / `lawful_basis` / `party_link` precedent. `@clycites/schema` is not
modified.

- **Purpose-bound.** A grant for `credit_assessment` is not a grant for
  `market_intelligence`. Purpose is matched exactly and never widened; "close
  enough" is how a consent regime becomes a formality.
- **Revocation is a new record.** `kernel.consent_revocation` is a separate
  table so that `consent_grant` can be strictly INSERT-only — withdrawal is an
  insert somewhere else, never an update here. Both tables carry a trigger that
  refuses UPDATE and DELETE even to the owner, and `kernel_app` holds only
  SELECT and INSERT. A grant that could be edited is not evidence of anything:
  a subject who withdraws in August must still be able to show they consented
  in July.
- **Resolved at request time, not at grant time.** A grant expired or revoked
  by the moment of the read does not authorise it.
- **A grant is personal data about the subject.** `GET /v1/consent/grants`
  returns a subject their own, and only their own. A grantee that could create
  its own grant would have written itself a permission slip; one that could
  list a subject's grants could enumerate everybody else that subject deals
  with.

Refusals are distinct — `no_grant`, `grant_expired`, `grant_revoked`,
`grant_wrong_purpose`, `grant_wrong_record_type`, `financial_needs_consent` —
because they mean different things to whoever has to act on them. An expired
grant is renewable, a revoked one is a decision somebody made, and a
wrong-purpose one means the integration is asking for something the subject was
never asked about.

## Retired

`consent_not_implemented` is gone with the stub. `foreign_subject_in_self_read`
is also gone: it existed to stop a page bundling somebody else's record into a
self read, and per-record classification makes that impossible by construction.

## Audit

Every decision, including every denial, is written to the audit log with its
reason, the access class relied on and the number of grants relied on. s.24(1)(c)
requires naming every third party who accessed a subject's data and s.16(4)
requires notifying them on correction; both are answerable only from that log.
`test/invariants/audit.test.ts` fails if a consent call site appears without an
audit write beside it.

## Known limits, and the next consent questions

**Retraction still has no party route.** Planting, Harvest and Observation now
resolve through one hop; Retraction deliberately does not. Its target may be
any record, including a priced one, and a hop that lands on financial data
without the hopping record being marked financial would route around s.9. The
retractor reaches it as asserter. Revisit with D7.

**Aggregate and anonymised access is out of scope.** Data Intelligence needs
it, and it is a different question: what de-identification standard makes an
output non-personal, tangled with s.37 on selling personal data. It is the next
consent question, not part of this one.
