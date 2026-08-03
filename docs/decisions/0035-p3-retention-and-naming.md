# 0035 — J5 retention notice, J6 naming discipline

Status: accepted.

## J5 — the notice given, not the policy now held

`kernel.retention_notice` (migration 0026) records what a subject was actually
told at enrolment: the wording in full, the period as stated to them, the s.7
or s.9 ground, the purposes, the language it was given in, how it reached them,
who gave it, and when.

Append-only, with its own trigger. A changed policy is a new row; the earlier
notice still governs the period before it. `inForce(party, at)` — not "latest"
— is the query that matters: a farmer enrolled in March was told something, and
a policy revised in June does not retroactively become what they were told.

Three choices worth defending:

**The full text, not a template id.** A template can be edited afterwards. If
the text is not stored here the notice is unprovable, which defeats the point
of recording it.

**`period_stated` is free text.** "Until three years after your last delivery"
is a real and common answer and is not a duration. A parsed interval would be a
claim of settledness this does not have, and would invite a job to act on it.

**The language is recorded.** s.13 requires the subject be *informed*, which a
notice in a language they do not read does not achieve. The claim should be
checkable rather than assumed.

`given_by` is the verified caller and is never read from the request body. A
notice that can name somebody else as its giver can be fabricated against them;
the API test asserts that a body field of that name is ignored.

Reads are asymmetric: the subject sees every notice given to them, anyone else
sees only what they themselves gave. A cooperative cannot use this route to
read what a rival told the same farmer.

### Deliberately not built: the expiry job

Nothing in the kernel acts on `period_stated`, and a test asserts no method on
`RetentionNoticeService` is named like one. The lawful retention period comes
from the 2021 Regulations read with the agricultural credit and cooperative
societies statutes, and that reading is unresolved — **D3, blocked on counsel**.
A job that deleted records on a period we cannot justify would be the one
mistake in this system that cannot be undone.

Recording the notice is both honest today and a precondition of any expiry job
that is ever written. Such a job would have to know what each subject was
promised, and after the fact that cannot be reconstructed.

## J6 — the kernel supplies measurements; lenders score

`test/invariants/naming.test.ts` walks the whole repository — every `.ts`,
`.md`, `.sql`, `.json`, `.yml` outside `node_modules`, `dist` and friends — and
fails on the scoring vocabulary named in `BANNED` there, in any spacing or
hyphenation. The patterns are stated once, in the test, and are deliberately
not repeated here: this document is itself scanned, and a rule with a carve-out
for every document that discusses it enforces nothing. It asserts explicitly
that `openapi.json` and the `docs/` markdown are in the scanned set, because a
rule that silently stops covering the contract is worse than no rule.

It also asserts the negative: `purpose: credit_assessment`, "a lender scores",
and "the risk that a bag factor is wrong" must all keep passing. A ban broad
enough to catch legitimate phrasing gets suppressed, and a suppressed rule
enforces nothing.

Why a hard failure rather than a style note: the banned phrases are terms of
art with settled meanings. A system that emits one has taken on an automated
decision under DPPA s.14 and a set of duties nobody here has agreed to
discharge. It also invites the exact misreading the design exists to prevent —
that a cooperative's scale drift is a fact about a farmer.

### FINDING — one occurrence, in the read-only schema package

`packages/schema/src/entities/index.ts:282` describes a forward commitment from
a buyer, using one of the banned adjectives about that buyer. It is prose about
a buyer's balance sheet, not an output of this system, so the substance is
defensible — but it is a banned word, and it sits in the contract document
applications read.

`@clycites/schema` is vendored and read-only, so the test carves out that path
by name rather than editing it. **This should be raised with whoever owns the
package.** The carve-out is by exact path prefix, so a new occurrence anywhere
else still fails.
