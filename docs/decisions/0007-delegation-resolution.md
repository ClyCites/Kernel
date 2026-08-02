# 7. Delegation is resolved at ingest, and forks refuse authority

Date: 2026-08-02
Status: accepted

## Context

Invariant 3: `on_behalf_of` requires an active `delegation`, verified at ingest.
The schema already refuses `on_behalf_of` without a `delegation` id, but it
cannot check that the delegation exists, covers this record type, or was live on
the day the delivery happened. That check needs the log.

## Decision

`DelegationService.authorise` runs before the record is appended. It refuses
unless all of the following hold, evaluated against `occurred_at` — not against
the wall clock, because a record ingested in August may describe a delivery in
July when the delegation was still valid:

- the delegation id resolves to a record of type `delegation`;
- neither it nor any correction of it has been retracted;
- `delegator` equals `on_behalf_of` and `delegate` equals `asserted_by`;
- `scope` contains the record type;
- `granted_at <= occurred_at`;
- `expires_at` is unset or after `occurred_at`;
- `revoked_at` is unset or after `occurred_at`.

A delegation may itself have been corrected — a widened scope, an extended
expiry — so the authority relied on is the tip of the supersession chain, not
the record the client happened to reference.

### Forks refuse authority

Spec §8 rule 4 permits two records to supersede the same original, and requires
the fork to be surfaced rather than resolved. Where a delegation has forked, the
kernel has two different answers to "may this person act for that person" and no
principled way to choose. It refuses.

This is deliberately stricter than the read path, which will surface a forked
delivery as a fork and let the caller decide. A delivery with two versions is an
open question about tonnage. A delegation with two versions is an open question
about authority, and acting on the more permissive branch cannot be undone.

## Why at ingest rather than at read

Checking on the way out would let unauthorised claims sit in an append-only log
looking like facts until someone queried them — and because nothing can be
deleted, they would sit there permanently. The log is the thing lenders will
read. What enters it has to have had its authority established.

## What this does not do

`scope` is matched against the record type only, not against individual fields
(spec open decision D7). A delegation covering `delivery` covers every field of
every delivery. Finer granularity is not modelled and should not be inferred
from this implementation.

The kernel does not derive authority from `membership`. Spec §5.3 allows a
cooperative bylaw to be the basis of a delegation, but it must still be recorded
*as* a delegation with `granted_via: "organisational_bylaw"`, which is then
flagged `delegated_by_organisational_bylaw` on every record relying on it.
Membership alone authorises nothing.
