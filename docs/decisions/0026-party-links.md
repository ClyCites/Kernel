# 0026 — Party links: `same_as` as a reversible assertion

**Status:** accepted, deferring open decision **D2**
**Migration:** `0019_party_link.sql`
**Code:** `src/identity/`, `src/api/parties.controller.ts`

## The question this does not answer

D2 asks how the kernel handles the same human being appearing twice: a farmer
registered by her cooperative in March and again by an input supplier in June,
under a different spelling and a different phone. D2 is still open. Nothing
here closes it.

## Why linking and not merging

The two options are not symmetrical, and the asymmetry is the whole decision.

A merge collapses two party ids into one. It is one statement, it is cheap to
write, and it is very hard to undo: every record that pointed at the losing id
now points at the winner, and reconstructing which record belonged to which
original party means reading the merge log and hoping it was complete. If the
match was wrong — and matching people by name and district in a country where
naming conventions repeat is wrong reasonably often — a merge has attributed
one woman's production history to another woman, and the repair is archaeology.

A link asserts that two ids are probably the same and leaves both standing.
Every record keeps the party it was written about. A consumer that wants to
treat them as one person may; a consumer that wants to see them separately
still can; and a link that turns out to be wrong is withdrawn without touching
a single record.

Collapsing links into merges later is a migration anybody can write. Going the
other way is not available. So links are what gets built.

## The shape

`kernel.party_link`, not `registry.party_link`. A link is a claim somebody
made, not reference data, so it carries the same two columns every other claim
in this kernel carries: `dataset` (0017) and `lawful_basis` (0019). Asserting
that two named people are the same person is processing personal data about
both of them, and it needs a ground.

Each row records:

- `relation` — only `same_as` today. The check constraint names the value
  rather than leaving the column free, so adding `guardian_of` or `successor_to`
  is a migration and a conversation.
- both party ids, stored in a fixed order (`left_party < right_party`), so that
  asserting B~A after A~B collides on the unique index instead of quietly
  creating a duplicate.
- `asserted_by` — who says so.
- `confidence`, in (0, 1]. Not a boolean, because matching is not a boolean.
- `evidence` — from a closed list: `national_id_match`, `phone_match`,
  `name_and_region_match`, `declared_by_subject`, `declared_by_organisation`,
  `assumed`. The weakest three are named explicitly so that a consumer can
  refuse to act on them.
- a retraction path: `retracted_at`, `retracted_by`, `retraction_reason`, all
  three present or all three absent.

The unique index is on `(relation, left_party, right_party, asserted_by)` among
live links. A second opinion from a different party is a second row, and that
is the point — two organisations disagreeing about whether two records are the
same person is information, not a conflict to be resolved by the database.

## Retraction is an update, not a new row

Everywhere else in this kernel, correction is a new record. Here it is not.

A link is a standing claim, not an event. "I no longer think these are the same
person" is not a new fact about the world; it is a property of the existing
claim. A trigger permits exactly one transition — null retraction to complete
retraction — and refuses everything else, including a second retraction and any
change to the twelve substantive columns. Deletes are refused outright.

So the history is preserved: the row says who linked, when, on what evidence,
and who withdrew it and why. That is the recoverability the whole arrangement
exists for.

## Reads resolve, and never collapse

`PartyLinkService.resolve` walks the links transitively, breadth-first, and
returns:

```json
{ "identities": ["…", "…"], "links": [ … ], "collapsed": false }
```

`identities` is a set, ordered with the party asked about first. `links` is
every link traversed, with its confidence and its evidence. `collapsed` is the
literal `false` and is in the response so that no consumer can mistake this for
a canonical id. **There is no canonical id.** A consumer asking for a farmer's
deliveries gets a set plus the links, and decides for itself.

The walk is capped at eight hops. A chain longer than that is not a person with
many aliases; it is a matcher that has joined two unrelated clusters, and
walking it to the end would return a set that defames everybody in it.

## Consent applies

`resolve` and `assert` both go through `ConsentService.decide` and both write an
audit entry, in that order, before anything is returned or written. A denial
that is not recorded is a disclosure decision nobody can review. The subjects of
the decision are the parties themselves, derived from the links rather than
taken from the caller.

`asserted_by` on a write is the verified subject, never a body field. A caller
who can name who asserted a link can attribute their guess to somebody else.

## Schema position

`@clycites/schema` is not modified. This is a kernel-side table, the same
position taken by `dataset` (0017) and `lawful_basis` (0019), and for the same
reason: it is a real requirement that has not yet earned a place in a versioned
public contract.

**Flagged as a v0.3 schema promotion candidate.** If field use shows that
consumers want links in the record contract rather than beside it, this is the
table that becomes a record type.

## What would change our mind

- If cooperatives consistently ask for a single merged view and never use the
  link set, the resolution endpoint is answering a question nobody asked, and
  D2 should be closed toward a merge with a preserved provenance trail.
- If nearly every link is `evidence: 'national_id_match'` with confidence 1,
  then identity resolution is really an index lookup and this table is
  overbuilt.
- If the eight-hop cap is ever hit in practice, the matcher upstream is wrong
  and that is the thing to fix, not the cap.
