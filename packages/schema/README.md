# @clycites/schema

Zod schemas and TypeScript types for the ClyCites append-only agricultural
record format. The package is independent of the kernel runtime.

```bash
pnpm add @clycites/schema
```

```ts
import { RecordDocument, SCHEMA_VERSION } from '@clycites/schema';

const record = RecordDocument.parse(input);
console.log(SCHEMA_VERSION, record.type);
```

Schema versions follow semantic versioning. See the repository contribution
guide for compatibility and proposal requirements.

Licensed under Apache-2.0.

Single source of truth for the ClyCites kernel core-facts schema.

Companion to **ClyCites Kernel — Core Facts Specification v0.2**. Section
references in the source (`§3.1`, `§5.11`, and so on) point at that document.

## Why this package exists

Everything downstream is generated from here — TypeScript types, the OpenAPI
contract, the database types, the client SDK. Nothing redefines a core entity
anywhere else. This is what makes the platform a kernel rather than a monolith
with good branding.

The package is versioned with semver and app teams cannot change it
unilaterally. Adding an enum value is a minor bump. Removing or repurposing one
is major.

## Layout

```
src/
  primitives.ts       branded UUIDv7 ids, timestamps, crop codes, regions
  enums.ts            closed vocabularies, incl. the measurement-method ladder
  values.ts           Quantity, Money, GeoPoint, Area, Grade, MediaRef
  envelope.ts         the envelope every record carries, and its invariants
  entities/index.ts   the 16 record types
  inference.ts        the quarantined model-output namespace
test/
  invariants.test.ts  24 tests that fail if a spec rule is broken
```

## The invariants this package enforces

These are not style preferences. Each one is enforced at parse time and covered
by a test that fails loudly.

| Rule | Where | Why |
|---|---|---|
| No `model_estimated` measurement method | `enums.ts` | Model outputs are Inferences. This is how a data asset stops being trustworthy. |
| An Inference cannot satisfy an entity schema | `envelope.ts` | `record_class` and `type` are pinned literals, so smuggling is a parse error, not a code-review catch. |
| `normalized_kg` requires a `conversion_id` | `values.ts` | A bag is not a fixed weight anywhere in Uganda. Inline factors cannot be re-derived. |
| `on_behalf_of` requires a `delegation` | `envelope.ts` | Otherwise it is an unbounded impersonation primitive. |
| `occurred_at_precision` has no default | `envelope.ts` | Manufactured precision poisons every downstream analytic. |
| Money is integer minor units | `values.ts` | Floats accumulate silent error across aggregation. |
| `held_by`, never `owned_by` | `entities/index.ts` | Ownership is a legal claim the platform cannot substantiate. |
| No Wallet, Balance, or Ledger export | tested | Non-custodial by design. Holding funds triggers Bank of Uganda licensing. |

## Usage

```ts
import { Delivery, isUnderwritable, weakestMethod } from "@clycites/schema";

const result = Delivery.safeParse(payload);
if (!result.success) {
  // Spec §1 P6: flag, do not reject. A rejected record becomes paper
  // and is lost forever.
}
```

## Commands

```
npm run typecheck
npm test
npm run build
```

## Status

Draft, tracking spec v0.2. **Not frozen.** Ten open decisions (D1–D10) remain,
and the field validation in spec §13 has not been run. Expect the crop taxonomy
(D1), the duplicate-party strategy (D2), and the erasure model (D3) to move.
