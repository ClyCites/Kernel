# 0025 — The audit log is a statutory record

- Status: accepted
- Date: 2026-08-03
- Supersedes: nothing. Extends 0001 and 0016.

## Context

Work order F. Two things forced the shape of this, and neither is observability.

**It is a statutory record, not a log.** The Data Protection and Privacy Act,
2019 s.24(1)(c) gives a data subject the right to be told the identity of every
third party who has accessed their data. s.16(4) requires that when a record is
corrected, the parties who received the incorrect version are notified. Both
questions are answerable only from here. That changes what a missing entry is: a
gap in an application log is an inconvenience, and a gap in this one is a
legally wrong answer to a subject's request.

**0001 needed it.** Append-only binds `kernel_app`, not the database. The schema
owner retains `DELETE`, and Postgres offers no way to revoke a right from a
table's owner durably. 0016 added a trigger that refuses live deletions for every
role — and conceded, in the migration itself, that an owner can drop the trigger
first. This log is what makes that concession survivable, because dropping a
trigger is a DDL event and DDL events land here.

## Decision

A schema of its own, `audit`, with one table, `audit.entry`. Migration `0017`.

### Ids only, never bodies

Uuid arrays, bounded scalars, and one `jsonb` query descriptor with a hard size
cap. Nothing here can carry what a record said — only which record it was, who it
was about, who asked, and what the kernel decided.

An audit log full of personal data is a second copy of the thing it protects,
sitting in a schema the application can write but cannot read. That is a worse
exposure than the one it was built to detect, and it is the failure mode this
kind of table reaches by accretion: one debugging session adds the request body
"temporarily".

Four layers, because a rule that is only written down is not a control:

1. `AuditDescriptor` is `Record<string, string | number | boolean | null>`. A
   record body is an object, so it is not representable. A call site cannot pass
   one without changing the type.
2. `AuditService.descriptor()` re-parses at runtime and **drops** offending keys
   rather than stringifying them, recording `descriptor_rejected` so the drop is
   visible. A truncated body is still a body.
3. `check (length(detail::text) <= 2048)` in the database.
4. A test asserts `detail` is the only `jsonb` column in the schema.

### INSERT only for the application

`kernel_app` holds `INSERT` on `audit.entry` and nothing else — no `SELECT`.
Reading the access log is a separate privileged path, because an application
that can read who has been looking at whom hands that answer to whoever
compromises it. `AuditRepository` has no read method and a test fails if one
appears.

A visible consequence: `insert ... returning` is unavailable, so the id is
generated in the application and the written row is returned from memory.

### Append-only for everyone

A `before update or delete` trigger refuses both for every role including the
owner, on 0016's reasoning. There is no retention purge and none is planned:
this is evidence.

### The database write is awaited and may fail the request

The opposite of how logging is normally treated, and deliberate. **A disclosure
that cannot be recorded does not happen.** This kernel fails closed elsewhere
for the same reason (see `consent.service.ts`), and a read that quietly proceeds
after its audit write failed is a read that cannot be answered for afterwards.

Ingest is idempotent per id, so a write that appends and then fails to audit is
safe for the client to retry.

### Shipping off-box is not awaited and cannot fail the request

`AUDIT_SHIP_URL` receives batches asynchronously. Every path out of
`AuditShipper` swallows its errors and counts them. A farmer's delivery does not
go unrecorded because a log collector in another data centre is down.

The queue is bounded at 10 000 and drops oldest-first, because an unbounded queue
turns an unreachable collector into an out-of-memory kill — which loses every
pending entry instead of the oldest few, and takes the kernel down with it.

### Denials are recorded with their reason

Every `ConsentDenied` is written before it is thrown, with the `ConsentReason`
that produced it. Every `RecordRejected` is written with its code. This is the
half a success-only log never sees: a shifting denial rate is the earliest signal
that something upstream has broken, and it is only readable as a signal if the
reasons are distinguishable from one another.

The unauthenticated sync pull is called out specifically. It is the widest
disclosure surface in the kernel, and an anonymous attempt against it is exactly
the event worth having.

### `dataset` on every entry

0011. A subject asking who has seen their data must not be handed a list of
reads against fabricated records that merely resemble theirs.

### DDL is captured

Two event triggers, `ddl_command_end` and `sql_drop`, writing `schema.ddl`
entries with the command tag, the object identity and `current_user`.

`sql_drop` filters to `original or normal` objects: a `drop table` cascades to
dozens of internal objects, and burying "somebody dropped the deletion guard"
under forty index entries defeats the purpose.

## Where the audit point sits

At the call sites — `ReadService.guard`, `SyncService.changes`, and
`IngestService.ingest` — not inside `ConsentService`.

`ConsentService.decide` stays a pure function with no I/O, which is what makes it
testable and what its own file comment promises. The cost is that a new
disclosure path could forget to audit, so that is enforced by test rather than by
structure: `test/invariants/audit.test.ts` walks every file under `src/`, and
fails if one consults consent without also writing an entry, or if one calls
`assertPermitted` — which throws without auditing and is now used by nothing.

## Consequences

- `Reader` and `IngestContext` carry a `correlationId`, set from the middleware.
  `correlationOf()` returns null rather than minting one, because an id created
  at the point of use correlates with nothing and only looks as though it does.
- The migrator must be a superuser for `0017`. `create event trigger` is
  superuser-only in PostgreSQL and there is no grantable privilege for it. The
  migration does not degrade gracefully: if the right is absent the deploy stops,
  which is correct, because a silently absent DDL capture is precisely the
  failure this is here to prevent.
- `scripts/backup.sh` and `scripts/restore.sh` verify the audit schema's
  constraints and grants, and deliberately **not** its row count — a restore is
  itself a long sequence of DDL, which this log records, so the count cannot
  match by construction. The duplication between the two scripts is retained for
  the reason given in their comments.
- Every hand-assembled service in the test suite now takes a real
  `AuditService`. Stubbing it would mean the whole suite exercises a path that
  never writes the column a subject's request is answered from.

## Findings

1. **Un-shipped entries are lost if the process dies.** They are not lost from
   the database, which is the record of legal consequence, so a privileged
   operator can reconcile from there. What is genuinely lost for that window is
   the *tamper evidence*. Closing it properly means shipping from a reader
   outside this process, which needs `SELECT` on `audit.entry` — and handing the
   application `SELECT` to buy that is a bad trade. A separate operator-role
   shipper would fix it and is not built.
2. **`GRANT` and `REVOKE` are recorded without an object identity.** Postgres
   reports no `object_identity` for them in `pg_event_trigger_ddl_commands()`.
   The command tag and the role are captured; which grant changed is not. The
   backup manifest covers this from the other side by fingerprinting the grants
   themselves.
3. **The statement text is not recorded.** It would say which grant changed, and
   it would also capture `create role ... password '...'` verbatim. Not worth it.
4. **Reading the log has no tooling.** There is no endpoint and no script that
   answers a s.24(1)(c) request; today it is a manual query as the owner. The
   grants are right, the data is right, and the operator path is missing. That
   is a deliberate scope boundary, not an oversight, but it means the statutory
   obligation is currently met by a person with `psql` rather than by a process.
