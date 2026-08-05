# ClyCites Kernel

The append-only record layer everything else sits on.

## The problem

A smallholder farmer in Uganda cannot borrow against her own production. Not
because she has none, and not because no lender wants the business — because
what she produced was never recorded in a form anyone can underwrite. She sold
fourteen bags of maize to her cooperative in June. There is a number in a
notebook, a figure in the cooperative's spreadsheet that was copied from the
notebook, and nothing that says who weighed it, on what, or whether "a bag" that
day meant the same weight as "a bag" the previous week. A lender looking at that
has no way to tell an honest record from an optimistic one, so it prices for the
worst case, which usually means declining.

The gap is not data. Cooperatives collect a great deal of data. The gap is
**provenance**: a record that carries who asserted it, on whose authority, by
what measurement, under what legal ground, and what happened to it since. A
figure without that is an opinion, and an opinion cannot be lent against.

This kernel records production in a form that keeps its provenance attached.
Records are appended and never changed; a correction is a new record pointing at
the one before it. Every quantity keeps the original observation — twelve bags —
alongside any conversion to kilograms and the factor used, so that when a factor
turns out to be wrong the original is still there to convert again. Every record
states the lawful basis it was collected under. Nothing that a model produced is
allowed into the same tables as something a person observed. Where the kernel
cannot be sure, it stores the record and flags it, because a record refused at
the door exists only in the head of the person who was turned away.

## What is not true of it

A reader deciding whether to trust this should have the following before
anything else, not after.

!!! danger "State of the system, as at 5 August 2026"

    - **No Merkle root has ever been published.** Roots are computed daily and
      stored. Nothing is anchored to any public ledger, so **the kernel has no
      tamper evidence today** — it can show you a root it computed and kept
      itself, which proves nothing an operator could not have fabricated. See
      [Anchoring](flows/anchoring.md).
    - **No real record has ever been stored.** Every record in every database
      to date is seed or dry-run data. The system has not been used by a
      cooperative, a farmer or a lender.
    - **Erasure is unimplemented.** There is no route that deletes a data
      subject's records, and the design question is open and with counsel.
    - **There has been no penetration test**, no external security review and
      no load test.
    - **There is no registration with the PDPO**, which the DPPA requires of a
      data controller before processing.
    - **Every unit conversion factor in the registry is assumed or synthesised.**
      Not one has been measured against a scale in a real store.

    The full list, with what each depends on, is
    [What is not yet true](compliance/not-yet-true.md). It is in the top-level
    navigation deliberately.

What *is* true is the shape: the invariants below hold, they have tests that
fail when broken, and the [dry run](getting-started/dry-run.md) exercises the
whole system end to end in about fifteen seconds.

## The one architectural invariant

```
Applications  →  Public API (/v1, OpenAPI 3.1)  →  Kernel  →  PostgreSQL
```

**No application ever reaches past the public API.** Not to the database, not to
a kernel module, not to a shared library that happens to know the table names.
That is what lets the schema change without seven applications breaking, and it
is the constraint most likely to be argued with under deadline pressure.

## Six invariants

Each has a test that fails when it is broken.

1. **Append-only, at the database role level.** `kernel_app` holds `INSERT` and
   `SELECT` and nothing else. There is no privileged path by which a correction
   could overwrite a record, because the permission does not exist — not a code
   review rule. [Append-only and supersession](concepts/append-only.md)
   states the qualification this claim needs.
2. **Observations and inferences never mix.** Separate schemas, separate tables,
   separate endpoints. A model output is reachable only by asking for it by
   name. [The inference quarantine](concepts/inference-quarantine.md)
3. **Provenance is mandatory.** `asserted_by` always; acting for someone else
   requires a delegation that was live when the event
   happened. [Provenance and the trust ladder](concepts/provenance.md)
4. **Flag, never reject.** Only structurally impossible records are
   refused. [The record model](concepts/record-model.md)
5. **Offline by default.** Client-generated ids, idempotent ingest, batch drain,
   cursor pull. [Offline sync](flows/offline-sync.md)
6. **Non-custodial.** No wallet, no balance, no funds move
   here. [What you cannot do](building/cannot.md)

## Where to go next

| If you are | Start at |
|---|---|
| Evaluating whether this does what it claims | [What is not yet true](compliance/not-yet-true.md), then [the dry run](getting-started/dry-run.md) |
| Building an application on it | [The authorisation model](building/authorisation.md) and [What you cannot do](building/cannot.md) |
| Running it | [Running locally](getting-started/running-locally.md), then the [Runbook](runbook.md) |
| Reviewing it for compliance | [Statutory mapping](compliance/statutory-mapping.md) |
| Asking why something is the way it is | [Decisions](decisions/index.md) — forty records, and they are the authority |
