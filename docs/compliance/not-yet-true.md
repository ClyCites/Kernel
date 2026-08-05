# What is not yet true

This page exists so that nobody has to discover these by reading the source.
It sits at the top level of the navigation deliberately: a reader who finds it
late has been misled by everything before it.

As at **5 August 2026**.

---

## No Merkle root has been published

Tamper-evidence is a **capability, not a property**. The kernel computes daily
roots and can prove a record's membership in one — but the only party attesting
to that root is the kernel itself, and a system that keeps its own root, shows
you that root, and confirms your record is in it has told you nothing it could
not have made up.

`GET /v1/anchors/roots` returns nothing for every date. No publisher is
configured, and no testnet topic has been created.

Do not describe this system as tamper-evident. See
[Anchoring](../flows/anchoring.md).

---

## Erasure is unimplemented

There is no way for a data subject to have a record erased. Append-only makes
this a design question rather than a missing endpoint: an erased record's leaf
hash would already be published, so the salt must be deleted as part of erasure,
and what remains must still be provably a valid tree.

Open decision **D3**, with counsel.

---

## Every conversion factor is assumed or synthesised

Not one has been measured. Every `normalized_kg` in the system rests on a factor
whose basis is `assumed_default` or on a synthesised seed row.

The provenance is honest — `kernel_assumed_conversion_share` publishes the
share, and it is effectively 1 — but a lender reading a derived mass is reading
an assumption, correctly labelled. See [The quantity problem](../concepts/quantity.md).

---

## No PDPO registration

s.29 requires registration with the Personal Data Protection Office. It has not
been done. Processing real personal data before it is done would be unlawful.

---

## No penetration test

None has been commissioned or performed. The specific untested boundary that
matters most: `verifiedSubject()` trusts a header set by the gateway. **If that
header can be set by a caller, every consent control in the kernel is
bypassed.** The kernel cannot defend this by itself.

---

## Ten open decisions

Four need cooperative field work; five need counsel. They are recorded in the
[decisions index](../decisions/index.md) rather than resolved by assumption.
The live ones a reader should know about:

- **D3** — erasure, above
- **D7** — whether delegation scope is per record type or per field
- **s.9(3)(c)** — whether a cooperative may rely on member-body processing for
  special data, and the `S9_CONSENT_REQUIRED_FOR_MEMBER_BODY` guard that
  depends on the answer

---

## FAO-derived yields are barred from commercial promotional use

The licence prohibits it. The `demo` profile exists so that promotional material
can be produced without them. See [Data sources](../data-sources.md).

---

## Also true, and worth stating

**No real record has ever been stored.** Every record that has existed in this
system was synthesised — by tests, by the seed, or by the dry run.

**Two constraints are `NOT VALID`.** `facts_lawful_basis_stated` and
`inference_lawful_basis_stated` bind new rows and have never been verified
against existing ones. See [Migrations](../operations/migrations.md).

**s.16(4) notifications accumulate with no channel to discharge them.** The
obligation is counted; nothing can currently act on the count.

**There is no operator tooling to read the audit log.** s.37 asks for production
on demand, and refusal reasons now go there, so this matters more than it did.

**Objection scope is a record type, and a farmer reasons in purposes.** Lodging
the objection she means returns `stopped_nothing_out_of_scope` — accurate, and it
stops nothing. Reported as a finding, not patched, because it is a decision.

**No timed restore drill.** Recovery objectives in Runbook §2 are stated
targets, not measured ones.

**Abandoned `upload_session` rows never expire.** Nothing reaps them.

**The region limb of the scope check is unreachable.** Dead code paths in a
consent check are the ones you least want unexercised.

**No test asserts the MinIO bucket's anonymous policy is `none`.** ADR 0040
requires it; nothing checks it.

**Runbook §1 contact rows are empty.** A breach procedure with nobody to call is
a document, not a procedure.
