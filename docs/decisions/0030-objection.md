# 0030 — Objection under s.7(3)

Status: accepted. Work order J2.

## Withdrawal and objection are not the same right

Conflating them would be the serious error here, so this is the first thing
the module states.

| | Withdrawal | Objection |
| --- | --- | --- |
| Target | a specific `ConsentGrant` | the processing itself |
| Effect | that grantee, that purpose, stops | processing stops where the basis permits |
| Basis | s.10(4), built in 0029 | s.7(3), this decision |

Withdrawal is narrow and already existed. Objection is broader and is
**conditional on `lawful_basis`**, which is why 0019 stores it per record:
s.7(3) stops processing "except for data collected or processed under
subsection (2)", and the answer to "can this farmer make us stop" is fixed at
collection and cannot be reconstructed afterwards.

## The response enumerates both sets

Never a boolean. `ObjectionOutcome` returns, per record type and ground:

- `stopped` — held on `consent`, `special_data_consent`, or no stated ground
- `continuing` — held on a s.7(2) ground, with that ground named, or outside
  the scope the subject chose

A subject who objects and is told "done" while the cooperative carries on under
`contract_performance` has been misled, and being misled is a worse outcome
than being refused.

An unstated basis stops. A record whose ground was never recorded cannot claim
a s.7(2) exemption it never stated.

## What an objection does not do

Carried in the response text and not only here, because a subject who assumes
"objection" means "erasure" has been misled by omission.

- **It is not erasure.** The log is append-only and the records remain. Erasure
  is s.16 and s.18, open decision D3, blocked on counsel.
- **It does not undo past disclosure.** Notifying parties who already received
  the data is J4.
- **It does not touch the audit log.** That is a statutory record under
  s.24(1)(c) and is the subject's own evidence of who saw what. An objection
  that could erase it would destroy the thing that makes the objection
  provable.
- **It does not remove another party's own record of a transaction it was part
  of.** A cooperative that recorded a delivery it made keeps its copy for its
  own accounting. What stops is disclosure of it to everyone else.

That last one is the line the whole work order turns on: `lawful_basis` governs
holding, grants and objections govern sharing.

## The asymmetry

**A cooperative officer may lodge an objection for a farmer under delegation.
No one but the subject may withdraw one.**

Lodging protects the subject, and a farmer with no smartphone must still be
able to object. Withdrawing removes the protection, and the party best placed
to want it removed is the one whose access it restricts. So withdrawal requires
the subject directly, and evidence at least as strong as an in-person
signature: `ussd_confirmation` is accepted for lodging and refused for
withdrawal, because a PIN on a shared handset is enough to raise a protection
and not enough to drop one.

The controller has the same shape: POST accepts `on_behalf_of` and
`delegation`, DELETE accepts neither. The database enforces the channel
restriction as a check constraint, so no future call site can route around it.

**Treat this as the general rule.** Acts that protect a subject may be
delegated; acts that reduce their protection may not.

## Effect on reads

An objected record, on a ground the objection reaches, is absent from every
read — not refused, absent, the same treatment retraction gets. Resolved at
request time against each record's own basis. There is deliberately no
pre-computed exclusion list: it would be a second copy of the answer, stale the
moment an objection is lodged or withdrawn.

Two carve-outs.

**Kernel integrity is unaffected**, because mass balance, supersession
resolution and anchoring read through the repository and never through the
guarded read path. An objection cannot make a lot fail to balance or a
supersession chain lose a link.

**The asserter keeps it**, along with the party it was acting for. That is the
"cooperative's own record" bullet above, implemented rather than only written
down.

## The subject keeps their own access

An objection restricts *others* processing your data. It is not an instruction
to stop showing it to you, so the subject is carved out of their own objection
and subject access under J3 will be carved out with them.

The alternative fails on the harm. A farmer objects to their cooperative's
processing and then cannot see their own plot, harvest or delivery history —
while the cooperative, carved out as asserter, still can. The objection would
have weakened the subject's position relative to the party they objected
against, which inverts the point of the right.

It also collides with s.24. The right of access is not conditional on not
having objected, and a design where exercising one statutory right suppresses
another is wrong on its face. The only route back would be withdrawing the
objection, which is a choice no farmer should be made to face: see your records
or keep your protection.

The response says so in as many words, because that is the line a farmer needs
to hear.

## Metrics

`kernel_standing_objections`, by scope. A rising objection rate is the earliest
signal that farmers do not trust what the platform is doing with their records,
and it arrives long before anyone complains to a regulator. It is worth more
than most of what is on that endpoint.
