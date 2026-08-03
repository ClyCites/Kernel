# 0031 — Subject access under s.24

Status: accepted. Work order J3.

## The route takes no subject

`GET /v1/subject-access` is scoped to the verified subject and has no id
parameter. A route that took one would be a route for enumerating everybody's
records with a single compromised token, and there is no legitimate caller who
needs it: an officer helping a farmer is helping *that* farmer, who can present
their own claim.

The assembly does not go through the consent guard, and that is deliberate
rather than an oversight. The guard answers "may this party see someone else's
record". A subject asking for their own data is not that question, and routing
it through the guard would have meant a farmer's own history arriving filtered
by grants they gave to other people.

## s.24(1)(c) is the hard part

The identity of every third party who has had access is answerable only from
the audit log, which is why F gated this work. F is deployed: `audit.entry`
exists, DDL is logged by the database itself, and every read path writes an
entry carrying `actor`, `subjects`, `records` and which permission was leaned
on.

But 0017 gave `kernel_app` INSERT on that table and nothing else, on the
reasoning that an application able to read who has been looking at whom hands
that answer to anyone who compromises it. Both that constraint and the
statutory right are real, so neither was relaxed.

Migration 0023 adds `audit.disclosures_to(subject, dataset)`: `security
definer`, `set search_path = ''`, execute granted to `kernel_app`. It returns
one subject's allowed disclosures and nothing else. `kernel_app` still cannot
select from `audit.entry`, and a `select` added to `audit.repository.ts` still
fails at runtime. There is a test that holds the application to that.

Two exclusions inside the function:

- **The subject's own reads.** Reading your own record is not a third party
  having had access to it, and a disclosure list padded with the subject's own
  visits buries the entries that matter.
- **Refusals.** A request that was denied disclosed nothing. Listing it would
  suggest otherwise.

The permission relied on is returned alongside the identity. "Somebody read it"
is not much of an answer; whether they read it on a grant the subject gave or
on a membership they never agreed to is the part a subject would act on.

## s.24(4) and (7): redact, do not refuse

Where responding would disclose another individual's data — a delivery with a
counterparty, a commingled lot — the record is returned with that individual's
particulars blanked. Wholesale refusal is the wrong answer, and the statute
offers redaction explicitly.

The line is *individual*, not *other party*. `PartyKind` distinguishes `person`
from `cooperative`, `business`, `institution` and `agency`, and only `person`
is redacted. A farmer who cannot see which cooperative received their maize
cannot dispute the weight, and s.24(4) was never about protecting a trading
identity.

Redacted fields are named in the response rather than silently removed, so the
subject knows there was something there and can ask about it. A party whose
kind cannot be established is treated as a person, because the failure that
over-redacts is recoverable and the one that under-redacts is a disclosure.

## What is in the answer

Records, including retracted and superseded ones — a retracted record is still
held, and what a subject asks for is not what a buyer would be shown. Each
carries the ground it was collected on, because whether it can be objected to
turns on that.

Also the grants the subject has given and the objections they have lodged. Both
are personal data about the subject and both are things they are most likely to
want to change after reading the rest.

## Truncation is reported, not paginated

The cap is 1000 records and breaching it sets `truncated`. A subject-access
response that silently stops at a page boundary is worse than a slow one, and a
subject with more records than this needs an export rather than a second page
they will never ask for.

## The thirty days

s.24(9). `due_by` is in the response, so the deadline is the subject's to hold
us to rather than ours to remember.

`kernel_subject_access_requests_total`, `_seconds_sum` and `_seconds_max` are
on `/metrics`. Latency is worth watching long before it approaches thirty days,
because the request that breaches the deadline will be the first one against a
subject with a large history, not the average one.

## Not in this work order

Erasure (s.16, s.18) is open decision D3 and blocked on counsel. Notifying
parties who already hold data when a record is corrected or objected to is J4.
Neither is implied by anything here.
