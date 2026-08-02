# 0003 — Toolchain: TypeScript 7 for compilation, TypeScript 6 for the linter

**Status:** accepted
**Date:** 2026-08-02

## Context

The brief (§3) fixes the stack but does not name a linter, while Phase 0 requires
`lint` to run in CI. The vendored `@clycites/schema@0.2.0` declares
`typescript: ^7.0.2`, so the whole workspace compiles under TypeScript 7.

`typescript-eslint@8.65.0` refuses to load against TypeScript 7:

```
Error: typescript-eslint does not support TS 7.0.
```

Support is tracked in typescript-eslint#10940. TypeScript 7 is documented as
installable side-by-side with TypeScript 6.

## Decision

- Each workspace package declares its own `typescript: ^7.0.2` devDependency and
  compiles with it. `pnpm --filter <pkg> run build` resolves `tsc` from the
  package, so builds are unaffected.
- The **workspace root** pins `typescript: 6.0.3`. The root copy exists only to
  satisfy `typescript-eslint`'s peer dependency; nothing is compiled with it.
- `pnpm lint` runs `eslint .` from the root rather than through Turborepo,
  because it is a single whole-workspace pass, not a per-package task.
- `packages/schema/**` is excluded from linting. It is vendored and read-only
  (brief §2); linting code we are not permitted to change produces noise, not
  signal.

## Consequences

- Two TypeScript versions are installed. This is deliberate and confined to
  tooling; no source file is ever compiled by TypeScript 6.
- When typescript-eslint supports TypeScript 7, drop the root pin to `^7` and
  delete this note.
- CI runs on Node 22 (the version named in §3). Local development on Node 24
  also works; `engines` requires `>=22`.

## Findings reported upstream

Linting the vendored schema (before it was excluded) surfaced three unused
bindings. They are cosmetic and were **not** fixed, because the package is
read-only here:

- `src/primitives.ts:28` — `brand` parameter of `id()` is unused; the brand is
  carried by the type parameter `B`.
- `src/entities/index.ts:11` — `HarvestId` imported but unused.
- `test/invariants.test.ts:3` — `z` imported but unused.
