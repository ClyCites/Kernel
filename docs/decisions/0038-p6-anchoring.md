# 0038 — P6: anchoring

**Status**: accepted
**Date**: 2026-08-04
**Supersedes**: nothing
**Related**: 0037 (media), 0006 and 0017 (append-only at the role level), work order P6

---

## 1. What anchoring buys, stated narrowly

A daily Merkle root published to a public consensus service proves one thing: a
given record existed, in exactly this form, on or before the day that root was
published, and we could not have gone back and changed it afterwards.

It proves nothing about whether the record is *true*. A farmer's weight
observation that was wrong when it was written is anchored just as firmly as
one that was right. Anchoring is a defence against *us* — against ClyCites
silently rewriting history — and against nothing else. Every claim made for it
beyond that is marketing.

That narrowness is the reason the design below is as small as it is.

## 2. One message a day, not one per record

Per-record anchoring is unaffordable and pointless. Unaffordable because HCS
charges per message and a season of observations is hundreds of thousands of
them. Pointless because the guarantee is identical: a root over a day's records
proves membership of every one of them, and a Merkle proof is a few hundred
bytes regardless of how many records are in the tree.

The message is deliberately tiny — a version, a kind, the date, the root, the
count and the algorithm identifier — and it is the same size for a batch of two
as for a batch of a hundred thousand. There is a test for that, because the
temptation to add "just one more field" to a message that costs money by the
byte is real.

The `alg` field exists so a verifier is not guessing at how the leaves were
built. If the leaf construction ever changes, the identifier changes with it
and old proofs stay verifiable.

## 3. Salting — the decision, stated plainly

**I salt.** Thirty-two random bytes per record, generated at batch time, stored
alongside the leaf in `kernel.anchor_leaf`.

The reasoning, since the work order asked for it directly:

Only the root is published, and a root over hundreds of records is not
reversible — there is nothing to grind. But a *leaf* hash is a different
object, and a leaf hash is exactly what gets handed to a third party during
verification. That is the whole point of the proof endpoint.

An unsalted leaf is `sha256(canonical(record))`. Consider what a real record
contains: a party id, a crop, a weight in a narrow and predictable range, a
date, a plot reference. Someone holding a leaf hash and a list of candidate
farmers can enumerate the plausible combinations and check each one. Weights
land in maybe a few thousand distinct values; dates in a few hundred; crops in
a few dozen. That is a search space of millions, which is nothing. The leaf
hash of a low-entropy record is a reversible commitment to that record.

A per-record random salt closes it. `sha256(0x00 || salt || digest)` is not
grindable without the salt, and the salt is 256 bits of nothing.

The cost is that the salt has to travel with the proof, which means the salt
has to be *stored*, which means a leaf hash is only as private as the row that
holds its salt. That is an acceptable trade: the salt lives in the same
database, under the same grants, as the record it protects. The alternative —
deriving the salt from a master key — makes every leaf hash grindable the day
that key leaks, and adds key management to a subsystem that currently has none.

A consequence worth being explicit about: **the proof endpoint is gated on the
ordinary read check.** Handing out salts freely would undo the reason they
exist. See §6.

## 4. The tree

Two decisions in the hashing, both of which are the kind of thing that is
obvious in hindsight and expensive to retrofit.

**Domain separation.** Leaves are prefixed `0x00`, internal nodes `0x01`.
Without this, an internal node hash is a structurally valid leaf, and a proof
for a subtree can be passed off as a proof for a record nobody ever wrote. The
prefixes cost one byte per hash.

**Odd nodes are promoted, not duplicated.** This is CVE-2012-2459, the Bitcoin
block-malleability bug. If the last node of an odd-length level is duplicated
to make a pair, then a tree over `[a, b, c]` and a tree over `[a, b, c, c]`
produce the same root — so the root commits to a multiset you cannot recover,
and two different batches can share a root. Promotion carries the odd node up
unchanged and does not have that property. Both behaviours are tested against
each other directly, because a test that only checks "the root is stable" would
pass under either.

**Canonical form.** The record digest is `sha256` over a canonical JSON
encoding: keys sorted, no whitespace, `undefined` dropped, non-finite numbers
rejected, dates as ISO strings. A verifier reimplementing this needs it to be
written down, so it is, both here and in the endpoint description.

## 5. The guard, stated three times

Anchoring seed data would publish fabricated farmer records irreversibly to a
public ledger. This is the one failure in the whole system that cannot be
undone: there is no retraction, no supersession and no erasure on a consensus
topic, and a root over invented records is indistinguishable from a root over
real ones.

So `dataset = 'live'` is enforced three times over, and each statement is
tested on its own:

1. **`CHECK (dataset = 'live')` on `kernel.anchor_batch`.** A batch row for any
   other dataset is refused by the database, whoever writes it.
2. **A trigger on `kernel.anchor_leaf`** that looks the record up in
   `kernel.record_key` and raises `23514` if its dataset is anything but
   `live`, with a message that says what would have happened. This catches the
   case the CHECK cannot: a correctly-marked live batch with a seed record
   smuggled into it. It also raises `23503` for a record that does not exist at
   all, so a leaf can never point at nothing.
3. **The selection itself.** `kernel.unanchored_record` only offers live
   records, so the ordinary path never reaches either guard.

Three statements of one rule is more than this codebase does anywhere else. It
is justified here by the asymmetry: every other invariant in the kernel fails
recoverably.

## 6. The verification endpoint

`GET /v1/anchors/{id}/proof` returns the record's salt, its digest, its leaf
hash, and the sibling path to the root, together with the topic and sequence
number where that root was published.

A third party can then:

1. Recompute `canonical(record)` and hash it — this is the digest.
2. Compute `sha256(0x00 || salt || digest)` — this is the leaf.
3. Fold the path: for each step, `sha256(0x01 || left || right)`, with the
   sibling on the side the step names.
4. Read the message at `topic_id`/`sequence_number` from any Hedera mirror node
   and compare its `root` field to what they just computed.

If those agree, the record existed unchanged on that day, and at no point in
that chain did they have to trust ClyCites. Step 4 in particular does not
involve us at all.

**The proof discloses no other record.** Every step of the path is a bare hash
and a side. No other record's id, type, digest or salt appears anywhere in the
response. That property is the entire point of using a Merkle tree rather than
publishing a list, and there is a test that walks the whole batch and asserts
that none of the other leaves' values appear in the serialised proof.

`GET /v1/anchors/roots` is unauthenticated, for the same reason the registry
is: a root you need our permission to see is a root you are trusting us for.

The proof endpoint is *not* unauthenticated, and the asymmetry is deliberate —
see §3. A caller who may not read the record gets 404, as does a record that
has not been anchored yet, because distinguishing the two would confirm the
record exists to someone who may not know that.

## 7. Idempotence and failure

`anchor_batch` has `unique (dataset, batch_date)` and `anchor_leaf` has
`unique (record_id)`. Re-running a day that is already published is a no-op;
re-running a day that failed retries the publish against the *same stored root*.
A record cannot be anchored twice, ever, by construction rather than by care.

The batch and its leaves are written in one transaction. A root without leaves
is a root nobody can prove anything against; leaves without a root have claimed
records that no later batch can pick up.

Selection is `recorded_at < date + 1` over everything not yet anchored, not
"records written on that day". A record that arrived late from an offline
device, or one whose batch failed to publish, is picked up by the next run
rather than being stranded on a day that has already been anchored. **A network
failure delays a batch; it never drops records** — and the test for that asserts
the records are in the tree immediately, before any successful publish.

Backoff is 60s, 5m, 30m, 2h, 6h, then holding at 6h. A batch that cannot
publish stays `failed` with its attempt count and last error, and the tree it
already built is untouched.

A kernel with no publisher configured still batches and still roots; it simply
never publishes. That is the same state a long outage produces, which means the
un-configured case is exercised by the same code path as the failure case
rather than being a special one.

## 8. Why `@hashgraph/sdk` is not a dependency

It was installed, measured, and removed.

- **+232 packages.**
- Among them `@hashgraph/proto` 2.26.0-beta.3 — a beta, in the dependency
  closure of the released SDK.
- Which requires `protobufjs@7.5.4` against the `8.0.0` already in this tree:
  an unmet peer dependency reported at install time.
- Whose install script this workspace does not run (`Ignored build scripts:
  protobufjs@8.0.0`).
- For a code path that cannot be exercised at all without testnet credentials.
  A smoke test could not even exit cleanly — `Client.forTestnet()` holds the
  event loop open.

That is a real supply-chain and correctness cost, paid today by every
deployment, for a subsystem most of them will never turn on. The same argument
that put the S3 client behind `ObjectStore` in P5 applies here with more force:
nothing in the kernel should know the name of a ledger vendor.

So `TopicPublisher` is a port. `HederaPublisher` implements it against a set of
locally declared structural interfaces and a dynamic import, so this file
compiles and the whole test suite runs with no SDK present. A deployment that
anchors installs the SDK itself and it is picked up at runtime. A deployment
that does not gets a kernel with no ledger dependency.

The tests use a fake publisher, which is correct anyway: the ledger is not the
thing under test, what the kernel does around it is.

## 9. Testnet, and what a mainnet cutover costs

`ANCHOR_NETWORK` defaults to `testnet` and stays there until field validation
is done.

Mainnet is a deliberate decision, not a config change. Setting
`ANCHOR_NETWORK=mainnet` is not enough on its own: `ANCHOR_MAINNET_ACKNOWLEDGED`
must also be set to a specific full sentence, or the module refuses to
construct a publisher at all. The sentence is long and is not a boolean on
purpose. What is being made permanent is other people's farm records on a
ledger nobody can edit, and one mistyped environment variable should not be
able to do that.

A mainnet cutover therefore requires, at minimum: field validation complete,
a decision recorded, a new topic, and an operator who has read the sentence
they are typing.

## 10. Append-only, with a twist

`anchor_batch` is *not* append-only in the way `facts.record` is — it has to be
updatable, because a batch is created `pending` and becomes `published` when the
receipt comes back, and `attempts` and `last_error` move on retry.

What is protected instead:

- `merkle_root`, `record_count`, `batch_date` and `dataset` can never change,
  at any state. Those four are what the root means.
- Once `state = 'published'`, *nothing* about the row can change, and it cannot
  be deleted. A published root is a public claim; revising it locally would put
  the database and the ledger into disagreement silently.
- `anchor_leaf` is append-only outright.
- A published batch must have a receipt, and a batch with a receipt must be
  published — one CHECK enforces the biconditional, so there is no state where
  we claim to have published without being able to say where.

## 11. Extending E — a restore verified against something we did not write

Backup and restore already compare a manifest. That is a real check against
corruption and no check at all against us: we wrote the manifest.

Published roots are different in kind. Each was on a public topic before any
given restore existed. So `restore.sh` now runs `anchor-cli --verify`, which
recomputes every published batch's root from the leaves actually present in the
restored database and compares. A mismatch means records are missing, altered,
or reassembled out of order — a failed restore, not a warning, and the script
exits non-zero.

The manifest carries the roots and their topic/sequence coordinates so that an
operator (or a court) can go further and read the same values off the ledger
directly.

## 12. Open

- **Nothing schedules the daily run.** `anchor-cli` is written and idempotent;
  wiring it to a scheduler is deployment work, not kernel work, but until it is
  done no root is ever published.
- **No mirror-node check in `--verify`.** The recomputation is against the
  stored root, not against the message on the topic. Fetching from a mirror
  node would make the restore check fully external, and needs a mirror URL and
  a network call in a script that currently makes none.
- **A retracted record stays anchored**, and must — a root cannot be
  unpublished. The proof still verifies; what it proves is that the record
  existed then, which remains true. Worth stating plainly to anyone who reads
  "retraction" as "removal".
- **Erasure under s.16/s.18 (open decision D3) collides with this directly.**
  A record erased from the database can no longer produce a proof, and its leaf
  hash is already published. The salt is the only reason that leaf is not a
  usable commitment to the erased record, which means *deleting the salt* is
  part of any erasure implementation. That is not currently written down
  anywhere else and needs to be part of D3.
