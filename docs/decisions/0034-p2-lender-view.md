# 0034 — The lender view is read as the lender

Status: accepted. Supersedes the note in `0023` that the report is produced by
the cooperative because consent denied everything.

## What changed

The seed now posts three `ConsentGrant`s after the records, as the subject,
through `POST /v1/consent/grants` — the same endpoint an application uses. The
report is then rendered as **Rift Valley Agricultural Finance**, a third party,
with `x-clycites-subject` set to the lender and `?purpose=credit_assessment` on
every read. Nothing in it is fetched with the cooperative's credentials.

The grants are deliberately uneven. Farmer A permits `party` and `delivery`;
farmer C permits `delivery` only, so their identity is refused and the report
says so; neither permits `harvest`, so harvests are refused by omission. A
corpus where every grant covers everything demonstrates nothing — the
interesting property of the consent module is what it refuses.

## FINDING — the consent endpoint rejected `+03:00`

`NewGrant.expires_at` was `z.iso.datetime()`. In zod 4 that rejects any offset
but `Z`. Every other timestamp in the system goes through `Timestamp` in
`@clycites/schema`, which is `z.iso.datetime({ offset: true })`. So the one
endpoint a Ugandan client would call with a local-offset timestamp — and every
client in the deployment region emits `+03:00` — returned 400 with
`expires_at: Invalid ISO datetime`, while the record endpoints next to it
accepted the same string. Fixed to `{ offset: true }`.

This is the failure mode the seed exists to catch. Three grants, three 400s,
and the report silently rendered as "everything refused" — which looked like a
correct consent decision rather than a validation bug.

## FINDING — only the list endpoint took a purpose

`GET /v1/records/:id`, `/chain` and `/inferences/:id` called `this.reader(request)`
with no purpose argument, so `purpose` was always `null` on those routes. A
third party holding a valid, unexpired, type-covering grant could enumerate
records through `GET /v1/records?purpose=…` but could never dereference one:
the single-record read denied with `purpose_required` every time.

Consent here is purpose-bound. A route with no way to state a purpose is a
route no grant can ever satisfy. All three now accept `?purpose=`.

## FINDING — a delivery needs a grant from both of its parties

`guard()` builds the consent decision from the records actually fetched and
throws rather than filtering — half a page is not an answer. A `Delivery` names
`from_party` and `to_party`, so a page of deliveries is denied unless *both*
the farmer and the cooperative have granted. This is correct and was not
obvious: the first draft granted only from the farmers and the whole deliveries
section came back empty, indistinguishable from a refusal by the farmer.

The seed therefore grants from the cooperatives as well, and the refusal line
for deliveries now says which of the two conditions failed rather than blaming
the farmer.

## Why the refusals are printed

A `WHAT WAS REFUSED` section sits beside the disclosures. It also states that a
refused read returns 404, not 403 — the kernel will not confirm a record exists
to somebody who may not read it — and that the reasons printed are the report's
own reading of the grants it holds, not something the kernel disclosed. The
subject can see the other side of this through `GET /v1/subject-access`.

## Not in this work order

- The report still names farmer C's party id in the section header even though
  the party record itself is refused. The lender knows that id from the loan
  application, so nothing is disclosed — but it reads oddly and could be
  replaced by the grant id.
- Withdrawal is not exercised. The report says a grant can be withdrawn; the
  seed does not withdraw one and re-render to show the difference.
