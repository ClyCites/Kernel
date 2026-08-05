# API versioning and deprecation

The version in `/v1` is a compatibility promise. A new implementation may add
capability within that version, but it must not reinterpret a contract that a
consumer already uses.

## Compatibility

A change is **breaking** when it removes a field or endpoint, narrows a type,
adds a required request field, changes the meaning of an existing enum value,
or tightens validation for an input the API previously accepted. Breaking
changes require a new API version unless the exceptional process below is
explicitly approved.

A new optional response field, a new endpoint, or a new enum value is
**additive**. Consumers are contractually required to degrade gracefully when
they receive an unknown enum value. Exhaustive enum handling without an
unknown-value branch is therefore a consumer defect, not a reason to prevent
enum growth.

## Deprecation

Deprecated endpoints and fields carry a `Deprecation` header and a `Sunset`
header as specified by RFC 8594. The minimum notice period is 180 days. A
replacement and migration note must be published when deprecation begins.

The kernel supports N-1 API versions: the current version and one prior version
remain live throughout the notice period. A version may be removed only after
its sunset date and after its successor has been available for the full notice
period.

## Enforcement

CI compares `apps/kernel/openapi.json` with the document at the pull request's
merge base. Any change beneath a pre-existing path or schema fails the gate;
new path and schema keys pass. This deliberately requires review even for some
additive edits to an existing shape, because accidental contract mutation is
more costly than an explicit exception.

An intentional exception requires the pull request label `breaking-change`.
CI maps that label to `BREAKING_CHANGE_APPROVED=1`. The label records approval;
it does not make a breaking change compatible or remove the obligation to
version and deprecate it.