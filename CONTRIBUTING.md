# Contributing

## Schema changes

Open an issue before a pull request. State the field or entity, the real-world
claim it represents, who asserts it, and why an extension field is
insufficient. Include representative valid and invalid records.

Changes to `packages/schema` must update its Zod schema, tests, generated
OpenAPI document, reference docs, and changelog entry. The compatibility rule
determines the version:

- Patch: clarification or implementation fix with no accepted-document change.
- Minor: backward-compatible optional field, entity, or enum extension.
- Major: any previously valid document becomes invalid or changes meaning.

Deprecations remain accepted for at least one minor release before removal in
a major release. Stored records retain their original `schema_version`; they
are never rewritten to match a new package.

## Validation

Run `pnpm typecheck`, `pnpm test`, `pnpm openapi`, and `pnpm docs:reference`.
Generated artifacts must be committed with their source change.

Contributions are accepted under the repository's Apache-2.0 licence.