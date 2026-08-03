# 0009 — A consent stub that fails closed

## Status

Accepted. Placeholder: the decision to be made is D3, not this one.

## Context

The kernel holds farmer production history — plots, plantings, harvests,
deliveries, obligations. Under the Data Protection and Privacy Act, 2019 that is
personal data, and disclosing it needs a lawful basis that is bound to a stated
purpose.

There is no consent specification yet. Core-facts spec §10 sketches the shape;
open decision D3 is where it will be settled.

The dangerous state is not "consent is unimplemented". It is "consent is
unimplemented and nothing calls it", because then the default is no check at
all, and the first external integration ships a disclosure with no basis behind
it. That failure is silent and it is not reversible.

## Decision

A single decision function exists now, with the signature the real
implementation will need, wired into every read path. Only its body should ever
change.

It allows exactly three things:

1. a subject reading their own records,
2. the party that asserted a record reading it back,
3. kernel integrity operations — supersession resolution, mass balance,
   anchoring.

Everything else is denied, including every purpose, with the machine-readable
reason `consent_not_implemented`.

### Why the signature is what it is

`subjects` is plural because a page is a disclosure about many people at once,
and the governing question is asked about all of them or it is not asked at all.
`purpose` is an enum because consent under the Act is purpose-bound: a basis to
assess credit is not a basis to sell market intelligence. `at` is explicit
because a consent grant has a validity window and the check is against a moment,
not against now.

### Why a decision object, not a boolean

Every denial is an audit event. A boolean discards the reason, and the reason is
the only thing that tells an integrator what to fix — or tells us that the
consent spec is now blocking real work and needs writing.

### Why the internal-use flag is derived from the record

Subjects and asserters are read out of the stored record via `subjectsOf()`,
after it is fetched, never from request input. A caller who can assert "this is
a self-read" has a bypass, not a gate. This is why the guard runs *after* the
query rather than before it: the kernel has to see what it is about to disclose
before it can decide whether it may.

### Why `integrity()` is not reachable from `decide()`

Integrity operations are a separate entry point with no request input at all. If
the integrity allowance were a branch inside `decide()`, some combination of
request fields would reach it, and that combination would be the exploit.

### Why an unattributed record is denied

A record whose subject cannot be identified cannot be governed: there is nobody
whose consent could be sought and nobody who could later withdraw it. Releasing
it would place data outside the regime entirely.

### Why the guard throws

A consent failure that returns a partial page is worse than one that fails: the
caller sees a successful response and cannot tell that anything was withheld.
`ConsentDenied` surfaces as a 403 problem document carrying the reason.

Note that the disclosure paths no longer call `assertPermitted()`. Since 0025
they call `decide()`, write an audit entry for the outcome — denial as well as
allowance — and then throw. The reason is that a refusal nobody recorded is
invisible, and a shifting denial rate is the earliest signal that something
upstream has broken. `assertPermitted()` remains as the shape the real consent
implementation is written against, and a test fails if a disclosure path starts
using it again.

## Consequences

The sync change feed is now scoped to the requesting party at the query level.
The unscoped whole-log feed noted in the consequences of decision 0008 is gone;
there is no consent basis that could have justified it. A device pulls back what
its own party wrote.

A read with no verified subject returns 403, not an empty page. The verified
subject arrives on the `x-clycites-subject` header, set by the gateway
(brief §6) — the kernel receives the claim, it does not establish it. Exposing
the kernel port directly would make every read forgeable.

Cross-party reads do not work. That is the point. If an integration needs data
out, that is the signal to write the consent spec and settle D3 — not to relax
this file.
