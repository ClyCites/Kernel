# 6. Idempotency is on the id, and a reused id is refused

Date: 2026-08-02
Status: accepted

## Context

Invariant 5 requires that ingest be idempotent on a client-generated UUIDv7. A
device that is offline for three days will replay its outbox on reconnection,
possibly more than once, possibly from two installs of the app. Submitting the
same delivery twice must not produce two deliveries.

The brief does not say what should happen when the *same id* arrives carrying
*different content*. That is a different situation from a replay and it needs a
decided answer.

## Decision

Idempotency is keyed on `id` alone, enforced by the primary key of
`kernel.record_key`.

- An id already in the log, with content matching what is stored → the stored
  record is returned unchanged, `replayed: true`. Nothing is written.
- An id already in the log, with content that differs → the submission is
  refused with `id_conflict`.

Content comparison excludes `recorded_at`, which the kernel assigns on receipt
and therefore differs on every submission by construction. Timestamps are
compared as instants rather than strings, because a device may send `+03:00`
where the log stores `Z`.

## Why a reused id is refused rather than flagged

Invariant 4 says flag, never reject, and this looks like a violation of it. It
is not, for the same reason a malformed record is refused: invariant 4 is about
*claims*. A farmer's implausible yield, an unconfirmed delivery, a quantity in
an unconvertible unit — these are things a human asserted, and the kernel is not
in a position to overrule them.

A duplicate id is not a claim. It is a broken client. There is no way to store
both records: the id is the primary key, so accepting the second would mean
either overwriting the first (an UPDATE, forbidden) or silently discarding it.
Discarding it while reporting success is the worst outcome available, because
the client believes the record is safe and it is not.

The four rejection codes for the write path are all structural in this sense:

| code | meaning |
| --- | --- |
| `malformed_record` | not a valid record of that type per `@clycites/schema` |
| `unknown_record_type` | no such entity |
| `id_conflict` | that id already belongs to a different record |
| `delegation_not_authorised` | no active delegation supports `on_behalf_of` |
| `supersession_invalid` | the correction target is missing, of another type, or another party's |

None of them is a judgement about whether the asserted facts are plausible.

## Consequences

- A client that generates ids badly finds out immediately, at the point where it
  can still be fixed, rather than discovering months later that some deliveries
  are missing.
- Replays are free and unlimited; a device may drain its outbox as many times as
  it likes.
- Because the check is against stored content, a client that resubmits with a
  legitimate correction must use a *new* record with `supersedes` set. That is
  the only correction mechanism, which is the intent of spec §8.
