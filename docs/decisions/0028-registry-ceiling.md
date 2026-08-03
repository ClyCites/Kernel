# 0028 — A ceiling on the observation vocabulary

**Status:** accepted, deferring open decision **D8**
**Migration:** `0020_registry_ceiling.sql`
**Test:** `test/invariants/registry.test.ts`

## The question this does not answer

D8 asks who owns the observation vocabulary and what that ownership entitles
them to do — approve new types, deprecate old ones, resolve conflicts between
an owner's definition and a coop's usage. Still open.

## The problem in the meantime

A registry with an owner column and no other pressure grows. Every plausible
measurement anybody can imagine gets an entry, because entries are cheap and
the cost of a wrong one is deferred.

The cost is not small and it is not deferrable forever. Records citing an
observation code are permanent. A code that turns out to mean the wrong thing
cannot be withdrawn, because withdrawing it orphans every record that used it.
So a vocabulary entry invented at a desk is a commitment made on behalf of
people who have not been asked.

Three of the five types seeded in `0010_registry_seed.sql` are exactly that:

| code | source |
| --- | --- |
| `loss.declared` | spec §9.1, decision 0011 |
| `moisture.grain_pct` | moisture meter reading at intake |
| `soil.ph` | *none* |
| `pest.incidence` | *none* |
| `storage.condition` | *none* |

Nobody asked for soil pH. It is in the registry because it is the kind of thing
an agricultural system might measure.

## What this does

Three rules, in the database rather than in review:

1. **Every entry names an owner.** Valid immediately; every row does.
2. **Every entry carries a citation** — who asked for it, or which standard it
   comes from. Added `NOT VALID`, following the precedent set by 0013's
   `lawful_basis` constraint: enforced for everything new, honest about the
   three rows that fail it.
3. **The vocabulary stays under twelve types**, enforced by a statement trigger
   that counts. Five are in use, so there is room for the field to ask for a
   handful without an argument, and the tenth request is a conversation.

The ceiling lives in a PL/pgSQL function, not in configuration. Raising it means
a new migration with a written reason. That is the intended friction: adding a
type should require justification, not just a migration.

## Why the three uncited rows stay

`registry.observation_type` is append-only and its trigger refuses `DELETE`, so
they cannot be withdrawn. Backfilling a plausible-sounding citation would be
worse than the gap — it would convert "we made this up" into "this is sourced",
which is precisely the failure `docs/data-sources.md` exists to prevent.

So they stay, uncited and visible, and the invariant test names all three
explicitly. The day one of them acquires a real citation, removing it from that
list is a deliberate edit somebody has to make and somebody has to review.

## What would change our mind

- If the field asks for a twelfth type with a real citation and a real user, the
  ceiling has done its job and should be raised.
- If it is never approached, the ceiling is theatre and the real constraint is
  that nobody wants new types — in which case D8's answer is that ownership
  barely matters.
- If a coop needs a type the kernel refuses to add, that pressure is the signal
  to resolve D8 properly rather than to raise the ceiling quietly.
