# 0037 — Media: bytes that survive a bad link and disclose nothing

**Status** accepted · **Work order** P5 (H) · **Supersedes** nothing · **Extends** 0020 (backup and restore)

A photograph of a delivery note is the most sensitive artifact this system
holds. It is also the one most likely to be taken on a phone with one bar of
signal, halfway up a hill, by someone paying for the megabytes. Both of those
facts had to be designed for at once, and they pull in opposite directions.

---

## 1. The object store: not MinIO

The work order asked us to check MinIO's licence and release situation before
committing, on the suspicion that the picture was stale. It was worse than
stale.

- `github.com/minio/minio` was **archived by its owner on 25 April 2026**. The
  repository is read-only. There is no branch to file against, no maintainer to
  file to.
- The last release is **`RELEASE.2025-10-15T17-29-55Z`** — itself a security
  fix, **GHSA-jjjj-jwhf-8rgr**, "Privilege Escalation via Session Policy Bypass
  in Service Accounts and STS". That is roughly ten months before this was
  written.
- The direction of travel had been visible for longer. The May 2025 "Breaking
  Release" removed the embedded console UI and **removed external identity
  provider logins (LDAP, OIDC) from the open-source build**, pointing paying
  customers at AiStor.

The disqualifying fact is not the licence and not the missing console. It is
that the last thing the project shipped was a privilege-escalation fix and
there is now no path for the next one. We would be running an unmaintained
credential system in front of farmers' photographs.

> **Reversed on 2026-08-05 by [0040](0040-minio.md).** The store is now MinIO.
> The reasoning below was not rebutted — the risk was accepted. Read 0040
> before relying on this section; two properties it describes as free are not
> free under MinIO.

**We use Garage** (`dxflrs/garage`, AGPL-3.0). Current stable **v2.3.0**,
released about three months ago; v2.2.0 and v1.3.1 within the six months
before that; regular contributor activity throughout. It speaks S3 signature
v4, presigned URLs, path- and vhost-style addressing, and the full multipart
set. v2.3.0 added `garage server --single-node` with
`GARAGE_DEFAULT_ACCESS_KEY` / `GARAGE_DEFAULT_SECRET_KEY` /
`GARAGE_DEFAULT_BUCKET`, which is why the compose service is four lines rather
than a bootstrap script.

We access it only through the AWS S3 SDK. Nothing in `src/media/` knows the
name Garage; swapping the implementation is a change to four environment
variables. That was the point of insisting on the S3 API in the first place.

### What Garage does not have, and why we can live without it

| Missing | Why it does not sink us |
| --- | --- |
| Bucket versioning | Keys are content hashes. An "overwrite" writes identical bytes or it is a different key. There is no version to keep. |
| Object lock / WORM | Same reason, plus append-only is enforced in Postgres where the citations live. A tampered object no longer matches the hash that names it, so the tampering is self-announcing. |
| Bucket policies and ACLs | Garage grants permissions per access key per bucket instead. This is why "no public bucket" is a property of the deployment rather than a policy someone must remember to set — there is no way to make it public by accident. |
| Server-side encryption beyond SSE-C | Disk encryption is the operator's job, and was already. |
| Most lifecycle rules | The two it has — `Expiration` and `AbortIncompleteMultipartUpload` — are exactly the two we need, for the `staging/` prefix. |

SeaweedFS (Apache-2.0, also actively released) was the other candidate. Its S3
layer is less complete and its operational model has more moving parts for a
deployment this size. Rejected on complexity, not on health.

---

## 2. Two hashes, because stripping changes the bytes

This is the decision everything else in the module follows from.

The client hashes the file it has. We then remove the EXIF — which changes the
bytes, and therefore changes the hash. So the claimed hash and the stored hash
cannot be the same number, and pretending otherwise would mean either not
stripping, or not verifying, or storing a hash of something nobody can fetch.

`kernel.media_object` therefore holds both:

- **`received_hash`** — SHA-256 of the bytes as they arrived. Checked against
  the client's claim. This is the integrity question: *did the upload arrive
  intact?* A mismatch means corruption on the wire or a client that lied, and
  it is one of the very few things this system correctly refuses rather than
  flags (P6 of the spec — flag, never reject — is about judgement of content,
  not about whether a file is the file it says it is).
- **`content_hash`** — SHA-256 of the bytes after stripping. This is what
  `MediaRef.content_hash` carries, what the URL endpoint is keyed by, and what
  will go into a Merkle leaf in P6. It has to be the stored bytes, because an
  anchored hash that no one can reproduce from what they can fetch proves
  nothing.

`byte_size <= received_size` is a constraint, not a comment: stripping only
ever removes.

---

## 3. Content-addressed keys

`live/sha256/ab/cd/abcd…` — dataset, algorithm, two fanout levels, the hash.

The alternative the work order names is `farmers/<id>/delivery-2026-05-07.jpg`,
and the objection to it is not aesthetic. That string discloses a party id and
a date to anyone who ever sees it: a proxy access log, an error report, a
screenshot in a support ticket, a URL pasted into a chat. The consent module
spends a great deal of effort deciding who may learn that a farmer made a
delivery on a date, and a key like that gives it away in a log line nobody
classified as sensitive.

The key we use discloses the dataset and nothing else. Two farmers who
photograph the same document share one object, which is a small privacy gain
on top of the storage one — though it also means a duplicate upload does not
overwrite the first sighting's provenance, so `first_seen_by` is the earliest
uploader and stays that way.

The algorithm is in the key path on purpose. When SHA-256 needs succeeding,
the new objects land beside the old ones instead of being ambiguous with them.

---

## 4. No public bucket; URLs measured in minutes

`DOWNLOAD_URL_TTL_SECONDS = 300`.

If possession of a URL is sufficient to fetch an object, then every consent
rule, every objection, every purpose limitation and every disclosure log entry
is bypassed for the most sensitive artifacts in the system by the simple act
of forwarding a link. So:

- The bucket has no anonymous read. Garage's per-key model means this is the
  default rather than a policy to apply.
- `GET /v1/media/{hash}/url` runs the ordinary read check first. It looks up
  every record that cites the object and asks `ReadService` whether this
  caller may read it. **Only if at least one comes back readable is anything
  signed** — the test asserts that a refusal generates no URL at all, because
  a URL that exists is a URL that can leak.
- A refusal is **404, not 403**. Distinguishing the two would confirm that a
  photograph exists for a farmer the caller may not read, which is the fact
  being protected.
- Five minutes is long enough to load an image on a slow connection and short
  enough that a link in a forwarded message is dead before it is opened. Hours
  would make the URL a bearer credential with a working lifetime.
- The release is written to the audit log as `media.read`, and
  `audit.disclosures_to` was widened to include it. A disclosure the subject
  cannot see in their own disclosure list is not a disclosure we can defend.

---

## 5. Resumable upload

A 4 MB photograph on a metered rural link fails partway through, repeatedly.
Without resume, the client's only options are to start again — spending the
bytes twice — or to give up, and the record then silently never syncs. Silence
is the failure mode we cannot detect from the server side, so it is the one
worth engineering against.

We implement the **tus** creation and core protocol: `POST` to open, `HEAD` to
learn the offset, `PATCH` at that offset to continue. Chunks are capped at
1 MiB and staged as individual objects under `staging/{session}/{offset}`,
assembled only when the declared length has arrived.

Three deliberate strictnesses:

- **A `PATCH` at any offset other than the current one is 409.** Not a partial
  accept, not a seek. A retry that crossed with a success would otherwise
  duplicate bytes into the middle of a file that still hashed as "arrived".
  The advance is a conditional `UPDATE ... WHERE received_size = $offset`, so
  two concurrent chunks cannot both win; the loser's staged object is deleted.
- **The session has an owner and it cannot be null.** Everywhere else in the
  API an unverified caller is allowed through and denied by the consent guard,
  which is right when the question is "may you see this". Here the question is
  "is this your upload", and a null owner would make every anonymous session
  belong to every anonymous caller — anyone could resume, and therefore
  finish, anyone else's file.
- **More bytes than declared is a rejection**, not a larger file.

Sessions carry a 48-hour expiry and a partial index on it.

> **Not yet built.** Nothing sweeps expired sessions or their staged objects.
> The index exists for a job that has not been written. Garage's `Expiration`
> lifecycle rule on the `staging/` prefix is the intended second line. Until
> both exist, abandoned uploads accumulate as storage cost — not as a
> correctness or disclosure problem, since a staged chunk is never reachable
> through any endpoint.

---

## 6. Metadata stripped by default

`metadata_stripped` is a column on every object and it is always `true`,
because there is no path that stores an object without stripping it.

A photograph of a maize heap taken on a phone routinely carries GPS
coordinates accurate to a few metres, a timestamp, a device serial, and often
the original file path — which on Android contains the owner's name. None of
that was consented to. All of it survives every conversation about consent,
because it is inside a file that everybody thinks of as "a picture".

- **JPEG** — drop `COM`, `APP1` (EXIF and XMP), `APP13` (Photoshop IRB, which
  wraps IPTC creator and location), and `APP3`–`APPF`. Keep `APP0`/JFIF, and
  keep `APP2` when it is an ICC profile: that describes colour, not a person.
  From `SOS` onward the entropy-coded data is copied verbatim, because walking
  it would mean decoding the image.
- **PNG** — drop `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME`.
- **WebP** — drop `EXIF` and `XMP `, **and clear the corresponding VP8X flag
  bits**. A VP8X still advertising an EXIF chunk that is no longer there makes
  decoders treat the file as corrupt, which would turn a privacy control into
  a broken photograph. The RIFF length is rewritten to match.

Every parser bounds-checks and **refuses** a malformed file rather than
passing it through untouched. A stripper that gives up and returns the input
is worse than no stripper, because the object still gets stamped
`metadata_stripped: true`.

Capture location is stored only when a client supplies it explicitly, in
`MediaRef.capture_location`, where it is a stated field subject to the same
rules as any other. The difference between that and EXIF GPS is consent.

---

## 7. The allow-list

`image/jpeg`, `image/png`, `image/webp`. 12 MB ceiling.

The type is decided by **sniffing magic bytes**, and the declared type must
match what the bytes actually are. A client's `Content-Type` is a claim, and
the only thing it is useful for here is failing fast before the bytes are
paid for.

The allow-list and the set of formats we can strip are the same list, and a
test asserts it. A format we accept but cannot strip would be stamped
`metadata_stripped: true` while still carrying GPS, which is a lie told by the
database.

**PDF is not on the list**, and it is the omission most likely to be
questioned, because delivery notes are often PDFs. A PDF can carry JavaScript,
embedded files, external references that fire on open, and an incremental
update history that preserves content someone believed they had redacted.
Accepting one means either shipping a sanitiser we are prepared to maintain
against a format with that attack surface, or accepting the risk. Neither is
in scope here. If field validation shows PDFs are essential, they get their
own decision document and their own sanitiser — not a line added to this
array.

Executables are refused by construction: nothing that fails to sniff as an
allowed image type is ever stored.

---

## 8. Why `media_reference` exists

The citation could have been derived by scanning record bodies for
`MediaRef`s. It is materialised instead, on ingest, because the URL endpoint
has to answer "which records cite this object" on every single request, and
that question cannot be answered by a JSONB scan of the fact log at
interactive latency.

`citedMedia()` recognises a citation only when an object has **both** a
64-hex `content_hash` **and** a string `storage_ref`. A bare `content_hash` is
not enough: anchoring roots and conversion digests are hashes too, and
treating them as media citations would make bytes reachable through records
that never mentioned them.

The wiring is optional (`@Optional()` on the repository in `IngestService`) so
that a kernel with no media configured still ingests records that happen to
carry a `MediaRef` — it simply records no citation for them.

---

## 9. Append-only, with one honest exception

`media_object` and `media_reference` carry the same append-only triggers as
the fact log. An object's hash, size and type are statements about bytes that
exist; changing them would be a lie, and deleting the row while the bytes
remain would orphan them in the other direction from the failure in §10.

`upload_session` and `upload_chunk` are **not** append-only, and hold the only
`UPDATE`/`DELETE` grants `kernel_app` has anywhere in the schema. An upload in
progress is not a fact about the world; it is a fact about a network
connection, and it is finished, abandoned or refused. Its rows are working
state and are expected to be swept. Keeping them append-only would mean
accumulating a permanent record of every failed upload attempt, which is
storage cost and a small disclosure surface in exchange for nothing.

The training role is revoked from all four tables. Photographs are not
training data, and the boundary is enforced where every other one is.

---

## 10. Extending 0020: a restore that recovers half a system

`scripts/backup.sh` fingerprints Postgres. That was the whole story until
media existed. It is now half a backup, and the missing half fails silently:

> A restore that recovers every row and no objects passes every check. Every
> foreign key resolves. Every count matches. Every constraint is valid. And
> every `MediaRef` in the system points at nothing.

Two additions, in both files, because [backup.sh](scripts/backup.sh) and
[restore.sh](scripts/restore.sh) duplicate the manifest query verbatim on
purpose — a shared helper would let the pair drift while still agreeing with
each other, which is exactly the failure this comparison exists to catch.

1. **A manifest line per dataset**, from `kernel.object_inventory`: object
   count, total bytes, and an ordered digest of every content hash. A restore
   that loses `media_object` rows now fails the diff.
2. **A bucket check**, `src/media/inventory-cli.ts`, which SQL cannot do. It
   lists the store and compares against the storage refs the database names.
   `manifest` records both sides at dump time; `verify` re-checks after a
   restore and exits non-zero when a named object is not there.

Objects the database does *not* name are reported and are not a failure:
content-addressed storage means an unreferenced key is an upload that stored
its bytes and then failed to register — wasted space, not lost evidence, and
deleting it is beyond this script's brief.

A backup taken with no store configured says so, loudly, in its output. A
restore that finds an `objects.txt` in the backup but no store configured to
check it against **fails**, rather than quietly verifying the half it can see.

P6 extends this again: once daily roots are published, a restore can be
verified against something we did not write ourselves.

---

## 11. What this does not do

- No thumbnails or transcoding. Both mean decoding untrusted image data in
  process, which is a materially larger attack surface than parsing container
  chunks.
- No virus scanning. The allow-list plus content sniffing is what we have.
- No sweeper for expired sessions (§5).
- No client-side encryption. Objects are readable by an operator with bucket
  credentials, exactly as records are readable by an operator with database
  credentials. That is a property of the whole system and is a separate
  decision if it is ever to change.
- The `Clycites-*` response headers on the tus routes are extensions to the
  protocol. A strict tus client will ignore them; ours needs the content hash
  back from the last `PATCH`, because that is the value it must cite.
