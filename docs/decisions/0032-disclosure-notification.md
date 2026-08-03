# 0032 — Notifying the parties who received the old version

Status: accepted. Work order J4.

s.16(4): on complying with a correction or deletion request, the controller
shall inform each person to whom the personal data has been disclosed.

0017 named this as one of the two statutory questions the audit log exists to
answer, and pointed at the `records` column. This is that answer, and it is
J3 read the other way round: J3 asked "given a subject, who read their data";
this asks "given a record, who received it".

## The same shape as 0023, for the same reason

`kernel_app` has INSERT on `audit.entry` and nothing else, because an
application that can read who has been looking at whom hands that answer to
anyone who compromises it. 0024 adds a second security-definer function,
`audit.recipients_of(record, dataset, exclude)`, rather than widening the
grant. Empty `search_path`, execute granted to `kernel_app`, revoked from
public. The application still cannot select from the table and there is a test
that holds it to that.

`exclude` is passed in by the application, which is safe because it only ever
narrows: the parties who must not appear are readable from the record and not
from the log, so the split falls out naturally.

Three exclusions inside the function itself:

- **Refused reads.** A denied request disclosed nothing. Notifying on one
  would tell a party about a record they were never shown — which is itself a
  disclosure, of the record's existence, to someone with no right to it.
- **Seed traffic.** 0011. A read of the seed corpus is not a disclosure of
  anybody's data. The discriminator is carried per audit entry, so this is
  checked rather than inferred from the ids involved.
- **Entries with no verified actor.** There is nobody to notify. This is a gap
  in the log rather than a recipient, and it stays visible as a gap because
  the number of entries and the number of recipients differ.

And three passed in from the record: the parties it is about, the party who
asserted it, and whoever wrote the correction. None of those reads was a
disclosure to a third party.

That list is deliberately only what the two records name directly. A party
reached in a hop — the holder of the plot a harvest sits on — is not excluded,
so they may receive a notification about a correction they were already close
to. That is noise. A missing notification is a breach. The two errors are not
comparable and the default is set accordingly.

## Raise, do not send

Delivery is an adapter concern. SMS, USSD, email, a buyer's webhook — none of
it belongs in a kernel, and a kernel with opinions about phone networks is a
kernel that has stopped being one.

What belongs here is the obligation: that it exists, who it is owed to, what it
concerns, and whether it has been discharged. `kernel.disclosure_notification`
holds one row per recipient per correction event, and
`kernel_disclosure_notifications_outstanding` puts the undischarged ones on
`/metrics`.

That gauge is not a backlog. Every count above zero is a party still holding a
version of a record we know to be wrong, who we were required to have told and
have not. `kernel_disclosure_notification_oldest_seconds` is next to it
because the count alone cannot tell fifty raised this hour from one
outstanding for a month, and the second is the worse breach.

## The one write-once field

Every other store in the `kernel` schema is insert-only and records a change
of state as a second row: a grant is withdrawn by inserting a withdrawal, an
objection by inserting into `objection_withdrawal`. This one is not, and the
exception is deliberate — a delivery receipt with no obligation behind it is
not a thing that can exist, so the two are one row.

What has to survive that exception is the property the append-only rule was
protecting: that nothing already written can be altered or removed. A trigger
in 0024 enforces exactly that. DELETE is refused for every role including the
owner. UPDATE is refused unless it is the single `null → value` transition on
`delivered_at` and `channel`, and it is refused a second time. The grant is
`update (delivered_at, channel)`, column-scoped, so the wrong statement fails
before it reaches the trigger.

## Chained corrections

A record corrected twice, disclosed only before the first correction, owes one
notification — and it falls out of the structure rather than needing a rule.
The second correction supersedes the *first correction*, and nobody ever
received that. There is nothing to tell them.

If the recipient read the corrected version as well, they get a second
notification, which is right: they received two versions and both have since
changed. The unit is the record that was disclosed, not the request that
prompted the fix, and that gives the correct answer in both directions without
anybody having to reason about correction events.

Replays are not skipped. A phone that never saw an acknowledgement is the
likeliest way for a first attempt to have been lost, so `raiseFor` runs on a
replayed id too and the unique index on `(record_id, correction_id,
recipient)` makes the second raise a no-op.

## View versus export, and why the volume is tractable

There is no export path. Every disclosure this kernel records is a read of a
record through the API, by a named party, at a known moment, and what they
hold afterwards is whatever they wrote down.

That is the whole reason notification volume is bounded. With exports, a
recipient list would grow without limit and never shrink — every bulk pull
would enrol its puller in every future correction to everything in it, in
perpetuity. Anyone proposing an export path should be made to say what they
intend to do about s.16(4) first, because the answer is not obvious and the
obligation does not go away.

## Recipients who no longer hold the data

A lender who read a delivery under a grant that has since expired is still
notified. Expiry of access is not erasure of what they saw: they still hold
the figure, and if it was wrong they are still relying on a wrong figure. The
function does not look at grant state at all, only at what was disclosed.

## Ordering, and what happens when raising fails

Raising happens after the `record.write` audit entry, not before it. A
correction that landed and was not logged is a hole in the statutory record. A
correction that landed and could not raise its notifications is a visible
failure the caller can retry, and the retry is safe because of the unique
index.

The error is not swallowed. A correction whose obligations could not be raised
must not be reported as complete.

## Not in this work order

- **Sending.** No adapter, no route to mark delivery from outside the kernel.
  `markDelivered` exists because the database guarantee needs a caller to be
  testable, and because whatever ships will need it.
- **Objections.** An objection is not a correction and s.16(4) does not reach
  it. A party who received a record before the subject objected is not
  notified today, and the runbook says so. That is a separate question and
  probably a separate statutory hook.
- **Erasure.** Open decision D3, still with counsel. When erasure lands it is
  a deletion within the meaning of s.16(4) and it raises notifications through
  this same path.
