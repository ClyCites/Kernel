# 0039 — Schema v0.3

**Status:** accepted
**Date:** 2026-08-05
**Supersedes nothing. Amends:** 0002 (derived fields), 0022 (lineage), 0029 (member body), 0038 (anchoring).

## Why one bump and not six

Six changes had accumulated against `@clycites/schema` since v0.2.0 was frozen.
None of them individually justified moving a version that every application
pins, and each of them individually would have cost a release, a re-pin and a
round of upgrade coordination across seven applications. Batched, they cost one.

The package has been treated as read-only since the kernel was started, which
was the right default and is why the list got to six. It is not a permanent
policy. This is the first deliberate bump, and the discipline being adopted is:
the schema moves rarely, in one motion, with the reasoning written down.

## The six

### 1. `stale` is gone from the inference body

Spec §8 rule 5 says superseding an observation "sets `stale`" on the inferences
computed from it. In an append-only log nothing is ever set. Correcting the
flag would take a second record asserting the first is stale — a fact about our
bookkeeping rather than about the world — and it would be wrong again the moment
another input moved.

The kernel has always derived staleness at read time from the inputs' current
tips (`src/records/staleness.ts`) and has always discarded a client-supplied
value on ingest. The stored boolean was never read. A field that is always
computed and never trusted is not part of the record, and leaving it in the
schema advertised a guarantee the kernel deliberately did not honour.

This closes the open question from 0022 about whether `stale` should be written
into the body the way `Lot.custodian` is. The answer is no, and the two are not
alike: `custodian` is derived but *stable* — it changes only when a custody
record is written — whereas staleness changes whenever any transitive input
moves, so there is no moment at which writing it down would be correct for
longer than the next append.

The read path is unchanged. `stale` still appears in every inference the API
serves, in the derived-labels block beside `superseded_by`, which is where a
computed field belongs.

### 2. `SubjectType.region` resolves against `registry.admin_region`

Five of the six subject types resolve against the fact log: a `subject_id` of
type `plot`, `lot`, `party`, `facility` or `planting` is the id of a record in
`facts.record`. `region` never did, and v0.2 did not say what it resolved
against instead. A region subject was an id pointing at nothing checkable, so a
yield inference over a district could not be verified to be about a district
that exists.

A region is not an observed thing. Nobody records the event of a district
existing; it is a registry entry. So a `region` subject resolves against
`registry.admin_region` and nowhere else.

This is enforceable rather than merely documented because registry rows carry
UUIDv7 ids drawn from the same space as record ids. The kernel can take a bare
`subject_id`, look at `subject_type`, and know which table to ask. v0.3 adds
`RECORD_SUBJECT_TYPES`, `REGISTRY_SUBJECT_TYPES` and `subjectResolvesAgainst()`
so the split is data rather than a comment.

The registry is versioned, so a region subject is a claim about a boundary as
the registry defines it *now*. Where the vintage matters — as it does for
conversions — the record carries `region_vintage` alongside. That asymmetry is
deliberate and is the same one the conversion table already makes.

### 3. `ConversionBasis` gains `definitional`

Until v0.3 the strongest available basis was `measured`, so kg→kg, tonne→kg and
gram→kg were all recorded as measurements. That is false. Nobody weighed a
kilogram to discover it was a kilogram. They are true by the definition of the
SI base unit.

Three consequences followed from the misclassification, and all three were the
kind of small wrongness that quietly corrupts a number a lender looks at:

- `unit_conversion_measured_shows_sample` had to carry a permanent exemption for
  three hard-coded ids, because a measurement with no sample size is otherwise
  refused. A constraint with an exception list is a constraint that has been
  told the model is wrong.
- `tonnageByConversionBasis()` reported identity and SI conversions as
  measured tonnage. "What proportion of our volume rests on an actual weighing"
  is a question a credit committee will ask, and the answer was inflated by
  every record denominated in kilogrammes.
- It flattened a real distinction. `published_standard` is the next rung down
  and is *not* the same thing: a standard body's 60 kg coffee bag is a
  convention that could have been chosen otherwise and could change. The SI
  kilogram could not.

`definitional` is placed first in the enum. The values now read strongest to
weakest, which is also the order a reader should trust them in.

A definitional conversion is exact: no sample, no region, no vintage, no expiry.
`isExactConversion()` says so in one place rather than in each caller.

**Not yet chained.** Migration 0031 supersedes the three SI rows as
`published_standard`, following work order Q1.1 to the letter, and the SI
Brochure is defensibly a published standard. `definitional` is the more precise
answer and a further supersession is available, but chaining it was not done
without a word first, because superseding a row twice in one afternoon leaves a
lineage that looks like indecision to anyone reading it later. Flagged for
instruction.

### 4. `special_data_member_body` stays absent, and now says why in the schema

s.9(3)(c) permits a body to process its own members' special personal data. It
is not a lawful basis value and will not become one.

A record asserting `special_data_member_body` would be asserting the
classification that governs access to itself — the record would be its own
warrant. The check would be circular, and any application that could write a
record could widen its own reach by writing one.

Membership is a fact about a party at a moment. It lives in the membership
records and is resolved per request, so access ends when membership ends. A
basis frozen at collection would keep granting access to a cooperative after the
farmer had left it, which is precisely the failure the section exists to
prevent.

This was decided in 0029 and was recorded only there. Its absence from the enum
looked like an oversight to every reader who met the enum first, so the
reasoning now sits beside the values it explains. Documenting an absence is
worth doing when the absence is load-bearing.

The open counsel questions on s.9(3)(c) — whether it permits a cooperative to
process members' financial information without separate explicit consent, and
whether it reaches a member's data unrelated to the body's own dealings — are
untouched by this and remain open. `S9_CONSENT_REQUIRED_FOR_MEMBER_BODY` still
defaults to the conservative answer.

### 5. `lawful_basis` is promoted to the envelope

The largest of the six.

The ground a record is held on was an out-of-band field on the ingest context,
supplied by an `x-clycites-lawful-basis` header, stored in a column, and absent
from the record itself. Four things were wrong with that:

1. **The anchoring digest did not commit to it.** Since 0038, a record's leaf
   hash is computed over the document. The lawful basis was not in the document,
   so the published Merkle root proved the delivery weight and said nothing
   about the authority under which the delivery was recorded. An operator could
   have changed a stored basis and every anchor proof would still verify. That
   is a hole in the tamper-evidence claim, not merely an inelegance.

2. **A disclosure could not show it.** A lender or a regulator reading a record
   got the claim without the warrant, and answering "under what authority do you
   hold this" took a second lookup against a table they have no access to.

3. **It was a contract callers had to discover from a rejection.** Every
   application that writes a record must supply a basis. An enum only the kernel
   could see meant the way to learn the permitted values was to send a bad one.

4. **It sat beside `dataset` while being nothing like it.** `dataset` is
   correctly out of the envelope: it is not a claim anybody is making, and a
   client that could assert it could mark its own records `seed` to slip past
   anchoring. `lawful_basis` was *always* client-asserted — the header came from
   the same caller as the body, across the same trust boundary — so keeping it
   out of the envelope bought no safety at all. It only hid the assertion.

The basis now sits in the envelope beside `asserted_by` and `supersedes`,
because it answers the same class of question: under what authority does this
record exist. It is required and has no default. s.7(3) decides whether a
farmer's objection can stop processing by looking at the ground relied on at
collection, and this log is append-only, so a record that arrives without one
can never acquire one.

**Compatibility.** The header still works and is folded into the envelope on
ingest, so an application that upgrades its kernel before its client does not
start failing writes. Where both are present they must agree: a new
`lawful_basis_conflict` rejection refuses the write rather than preferring one.
Silently preferring either would mean the basis the record shows is not
necessarily the basis the write was authorised under, which is the one question
the field exists to answer.

The absence check runs before schema validation, so a missing ground is still
reported as `lawful_basis_required` and not as one more malformed field. The
distinction matters to the caller: a malformed record is a bug in their
serialiser, an absent lawful basis is a gap in their authority to send it.

`LAWFUL_BASES`, `objectionStops()` and `isLawfulBasis()` remain exported from
`src/records/lawful-basis.ts` and now delegate to the schema, so no call site
moved. The kernel keeps `checkBasis()` — which basis suffices for which record
type is a kernel policy, not a shape.

### 6. The comment adjective on `Agreement`

`packages/schema/src/entities/index.ts` described the buyer in a forward
commitment with the standard lending adjective for a party already assessed as
good for the money, in the sentence explaining why the entity is core.

That assessment is precisely what this system exists to make possible for
people who have never had one. Helping oneself to it as a given property of the
buyer is an assumption about who already counts — and the invariant test in
`test/invariants/naming.test.ts` bans the vocabulary outright, which is why this
paragraph does not use the word either. The comment now says `solvent`: the
buyer can pay. Same meaning, no judgement smuggled in.

A comment, and only a comment. It is changed because comments are how the next
person learns what this is for.

## Migrations

Migrations are immutable; the migrator refuses a changed checksum. Nothing in
v0.3 edits an applied migration.

Nothing in v0.3 requires a new one either. `lawful_basis` has been a column on
`facts.record` and `inference.record` since the first hardening pass, with
`facts_lawful_basis_known` already constraining it to the nine values. The
promotion moves where the value is *read from* on the write path, not where it
is stored. `ConversionBasis.definitional` is a schema value with no row using it
yet; `unit_conversion_basis_check` will need widening in the migration that
first writes one, which is the migration that chains the SI rows, which is
waiting on the instruction in item 3.

The "one checksum update" the work order asks for is
`test/schema-pin.test.ts`, which asserts the version the kernel was built
against. There is no separate schema checksum artefact, and this note exists so
the next reader does not go looking for one.

## What is still open after this

- Whether to chain the three SI conversions on to `definitional` (item 3).
- `facts_lawful_basis_stated` and `inference_lawful_basis_stated` are still
  `NOT VALID`. Promotion to the envelope makes them more nearly true — every
  new record must state a ground — but validating them requires a pass over the
  existing rows and is a separate exercise.
- The region limb of the read-scope check is still unreachable (spec §13
  question). Item 2 settles what a region subject *means*; it does not settle
  who may read one.
