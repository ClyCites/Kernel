# The dry run

```bash
bash scripts/dry-run.sh
```

Fifteen seconds, from empty volumes to a verified restore. It is the best
onboarding artifact the project has: someone who runs it once understands the
system better than someone who reads every page here.

It tears down all state, brings up PostgreSQL and MinIO from empty volumes,
migrates from zero, boots the kernel on port 3100, and then walks eleven stages
in the order a real cooperative would meet them — enrol somebody, record what
they produced, let the other side confirm it, disclose it to a lender, correct
it, anchor it, answer a subject access request, handle an objection, back
everything up and restore it, and finally render what a credit officer sees.

Every excerpt below is real output from a run on 5 August 2026, not an
illustration.

---

## Stage 1 — stand up

**What it proves: append-only is a database permission, not a coding
convention.**

```text
  migrations, from zero
    applied 32, already applied 0, partitions ensured 52

  the app role's grants — this is where append-only actually lives
      facts.record           INSERT, SELECT
      inference.record       INSERT, SELECT
      kernel.record_key      INSERT, SELECT

      INSERT and SELECT. Not UPDATE, not DELETE, and no exception for the
      owner's own rows — a correction has to be a new record because the
      database will not accept anything else.
```

The stage then prints every table where the application role *does* hold
`UPDATE` or `DELETE`, so the exceptions are read rather than assumed:
`anchor_batch`, `party_link`, `upload_chunk`, `upload_session`. Each is
transient bookkeeping. None is an observation.

Printing the exceptions matters more than printing the rule. A claim that
nothing can be updated is easy to make and easy to quietly stop being true.

## Stage 2 — enrol

**What it proves: a claim made on somebody else's behalf has to point at a
delegation, and the retention notice is recorded as an event.**

```text
  cooperative                    019fd19a…ad22
  farmer (no Account)            019fd19a…982d
  officer                        019fd19a…d369
  bylaw delegation               019fd19a…9e91

  retention notice to farmer
    given via     in_person_reading
    period stated seven years after membership ends
    lawful basis  contract_performance
```

The farmer has **no Account**. She has a feature phone and no app, and the
kernel does not require her to have one to be a party to records about her. The
officer has an Account and a delegation resting on the cooperative's bylaw —
which is a weaker basis than an individual mandate, and everything asserted
under it is flagged as such for the rest of its life.

The retention notice is a record of *what she was told*, on the day, in the
language used — not a copy of the policy currently in force. Under DPPA
s.13(1)(i) the duty is to have informed her, and a policy page that changed last
Tuesday is not evidence of that.

## Stage 3 — record

**What it proves: a resumable upload, and that image metadata is stripped
before storage.**

```text
  upload session 019fd19a…79a7  98528 bytes, EXIF and a comment
    sent 32842 bytes, then dropped the connection
    resumed: the server says offset 32842, not zero
    stored: af736f6bd63be45b…  metadata_stripped=true
    declared hash 535e349a75507cca…  differs, because EXIF is gone
  the delivery needs s.9(3) consent — contract performance will not carry it
  delivery (12 bags)             019fd19a…7965

  stored bytes read back: 98336 of 98528 uploaded
    EXIF segment absent, Exif tag absent, comment absent
    the GPS coordinates of the farmer's home are not in the stored object.
```

The connection is dropped mid-upload on purpose. A field officer on a 2G
connection is the normal case, not the exceptional one.

The declared hash not matching the stored hash is the interesting part. The
client hashed what it had; the server stripped the EXIF and stored something
different, so the two disagree **and the system says so** rather than papering
over it. The GPS tag in that photograph was the location of the farmer's home.

Note the line about lawful basis: the delivery cannot ride on
`contract_performance`, because it concerns financial information, which the
DPPA treats as special personal data requiring s.9(3) consent.

## Stage 4 — confirm

**What it proves: a confirmation is the counterparty's own record, and the party
who recorded the delivery cannot make it.**

```text
  confirmation  {"confirmed":false,…,"independent":false,"count":0}

  The farmer now confirms, by the USSD-shaped path: the party at the
  keyboard is the farmer, and the act is theirs alone.

  accepted: 019fd19a…cce4
  confirmed     true
  independent   true
  channel       "ussd_pin"

  the coop confirming its own delivery: REFUSED  403 the party who recorded
  the delivery cannot confirm it — a confirmation is the other side saying so
```

`counterparty_confirmed_at` used to be a nullable timestamp on the delivery,
set by whoever wrote the delivery — which meant the cooperative attesting that
the farmer agreed. One-sided data wearing a two-sided name. It is now derived
from a record the farmer asserts herself, and the whole credit thesis rests on
that difference. See [Two-sided confirmation](../flows/confirmation.md).

## Stage 5 — disclose

**What it proves: the farmer's consent alone is enough, and a refusal names
nothing.**

```text
  the lender reads the delivery, holding the farmer's grant
    200 disclosed

    The farmer's grant alone was enough, which is what anyone asking a
    farmer for consent reasonably believes they are getting.

  the same lender reads the plot, which no grant covers
    404 404 no such record, or not yours to read
```

Two findings are visible here at once.

The delivery names two parties — the farmer and the cooperative. The consent
gate used to count both as data subjects and wait for the cooperative to consent
to disclosure of its own trading activity. The DPPA protects individuals; a
cooperative is a party to a record and not a data subject.

The refusal is a bare **404**, not a 403. A 403 quoting the record id, its type
and the party id of whoever's grant was missing is itself a disclosure: it
confirms that party exists and asserted something. The reason goes to the audit
log, where a question about a refusal should be answered from.

The refusal is printed beside the disclosure on purpose. It is the half a
regulator asks to see and the half no demonstration ever shows.

## Stage 6 — correct

**What it proves: a correction is a new record, and everyone who saw the old
version is owed a notification.**

```text
  correction 019fd19a…5091 supersedes 019fd19a…7965  1200kg -> 1164kg

  the farmer's standing grants after the correction: 200
    a disclosure notification is raised for a grantee that already saw the
    superseded version; it is queued, not sent, because the kernel does not
    own a channel.
```

The original is not edited and not deleted. Both versions stay addressable by
id, because a lender auditing a dispute needs to see what was claimed before it
was corrected. `GET /v1/records/{id}/chain` returns every version, oldest first.

DPPA s.16(4) requires notifying the third parties who received the old version.
The kernel raises the notification and queues it. It does not send it, because
it owns no SMS or email channel — and a system that claims to have notified
somebody when it merely wrote a row is worse than one that admits the gap.

## Stage 7 — anchor

**What it proves: everything upstream of publication works, and publication does
not.**

```text
    anchor: 2026-08-05 root=f2d27546…4b3f07 records=13 state=pending
    anchor: not published — no publisher is configured.

  ─── and now, in a separate process that shares nothing with the kernel ───

    2. recompute the leaf: sha256(0x00 || salt || record_digest)
       computed       2115b289743bc3018da019c7b75bede16a0757fdda24b6c9f1c3fdea2133c649
       published      2115b289743bc3018da019c7b75bede16a0757fdda24b6c9f1c3fdea2133c649
       match

    3. walk the path to a root
       computed root  f2d27546b0187b1ff4856c09d2682f92318d6ab683a45c02b20d6d84484b3f07

    4. NO PUBLIC ROOT FOR 2026-08-05

       So steps 1 to 3 proved the record is consistent with a root the kernel
       handed us in the same breath. That is not tamper evidence. A kernel
       that keeps its own root, shows you that root, and confirms your record
       is in it has told you nothing it could not have made up.
```

The verifier is a separate process with no database access and no kernel
imports, which is the only way a proof means anything.

This stage is the most important thing on the site for anyone evaluating the
claim. The Merkle construction is correct, the proof endpoint works, the
external verifier recomputes the leaf and walks the path — and **none of it is
evidence of anything until a root is published somewhere the operator cannot
edit.** The dry run exits non-zero-shaped on this deliberately: `external
verification: INCOMPLETE — Reportable.`

## Stage 8 — subject access

**What it proves: s.24 answers with who read what, and withholds the part that
would identify somebody else.**

```text
  due_by  2026-09-04T11:06:17.908Z  (30 days out)
  access log: 12 entries, of which 2 a disclosure to somebody else
    the lender is 019fd19a…3a44 — named above, as s.24(1)(c) requires.

  records held about the farmer: 5
    delivery   019fd19a…5091  basis special_data_consent  redacted: asserted_by
    delivery_confirmation 019fd19a…cce4  basis special_data_consent
    plot       019fd19a…a1f2  basis contract_performance

  the delivery's counterparty is withheld: asserted_by
    s.24(4) withholds the part that identifies another individual rather
    than refusing the whole record.
```

The other nine access-log entries are the cooperative reading its own records
and the officer reading what he asserted. They are in the list because the
farmer is entitled to know every touch, not only the interesting ones.

## Stage 9 — object

**What it proves: an objection that stops nothing says so.**

```text
  what the kernel said back to her:
    This objection stops disclosure of 2 record(s) to others.
    effect recorded, and counted on /metrics: stopped_some

  what stopped:
    the lender's credit_assessment read  404 — refused

  what continues, and on what ground:
    the coop's own read  200 — the coop is a subject of this record, not a
      third party to it.

  and now the objection she meant to lodge, in her own terms:
    Nothing stopped. Every record about you is of a type this objection did
    not name. Lodging it without a scope would reach all of them.
    effect: stopped_nothing_out_of_scope
```

The second objection is the point. She pressed a button marked "I object", and
under s.7(3) it correctly stopped nothing — because the processing runs on her
consent, and consent ends by **withdrawal**, not objection. Previously she was
told two accurate lists and no answer. Now she is told nothing stopped, why, and
which specific grants she can withdraw instead.

The stage also prints a finding that has **not** been fixed: objection scope is
a record type, and a farmer objecting thinks in purposes. See
[Subject access and objection](../flows/subject-access.md).

## Stage 10 — back up and restore

**What it proves: a backup that would skip the photographs cannot exit 0.**

```text
    backup: 1261 manifest lines
    backup: object inventory taken from …/objects-before.txt
    backup: objects present (2)

    restore: verified — 1261 manifest lines match
    restore: backup recorded objects as present
    restore: database verified; OBJECTS NOT VERIFIED (deferred)

  bringing the kernel back, and proving a MediaRef still resolves
    objects: verified — every named object is present
  the evidence photograph still resolves after restore: 98336 bytes
```

The manifest carries row counts, primary-key fingerprints, every constraint with
its validated flag, and every table grant. The restore regenerates it and diffs;
exit 0 requires an exact match, because append-only leaves no reconciliation
path if a restore silently drops a constraint.

The failure mode being prevented: a restore that verifies 1261 manifest lines
perfectly and resolves no photographs. `restore.sh` refuses to verify against a
manifest with no object section at all.

## Stage 11 — the lender view

**What it proves: the lender sees what its grants allow, and no more.**

```text
  Rendered as the lender, through the public API, with the grant it holds.

  delivery             404
  delivery chain       404
  harvest              200
    "quality_flags": ["measurement_below_underwritable"]
  plot (no grant)      404
```

The delivery is 404 because of the objection lodged in stage 9 — the same read
that returned 200 in stage 5. The harvest comes back flagged
`measurement_below_underwritable`, because it was `field_estimated`: usable for
operations, not for lending against.

Nothing here is rendered from a privileged view. It is fetched through the same
public API an application would use, with the same credentials, so what the
demonstration shows and what a lender would get cannot diverge.

---

## What it does not prove

- That any of this works at scale, under load, or on a bad network.
- That the tamper-evidence design is sound in practice — see stage 7.
- That a farmer can use it. The dry run is a farmer-shaped script, not a
  farmer. That gap is the argument for field visits, and it was made by the dry
  run rather than by anyone reviewing it.

Next: [Reading the output](reading-the-output.md).
