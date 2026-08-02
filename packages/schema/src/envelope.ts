import { z } from "zod";
import {
  AccountId,
  DelegationId,
  EventId,
  Extensions,
  PartyId,
  Timestamp,
} from "./primitives.js";
import { OccurredAtPrecision, RecordClass } from "./enums.js";

/**
 * Spec §4. Every record in the kernel carries this envelope. No exceptions,
 * including Inference.
 *
 * Two invariants are enforced here rather than in application code, because
 * both were violated by accident in v0.1 of the specification:
 *
 *   1. `on_behalf_of` requires a `delegation`. Without it the field is an
 *      unbounded impersonation primitive — anyone able to write a record could
 *      claim to be writing it for anyone else.
 *
 *   2. `asserted_by` is never null and never inferred. If the system cannot say
 *      who is making a claim, the claim does not enter the kernel.
 */
export const Envelope = z
  .object({
    id: EventId,
    type: z.string().min(1),

    /**
     * Spec §6. Separates what the world did from what a model thinks. These
     * live in separate namespaces, not merely separate flags — but the
     * discriminator travels with every record so the distinction cannot be
     * lost in transit.
     */
    record_class: RecordClass,

    schema_version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "semver"),

    occurred_at: Timestamp,
    occurred_at_precision: OccurredAtPrecision,

    /** Set by the kernel on receipt, never by the client. */
    recorded_at: Timestamp,

    /** Who is making this claim. Spec §1 P1. */
    asserted_by: PartyId,

    /** Which principal was authenticated. Distinct from the subject. Spec §5.2. */
    authenticated_as: AccountId.nullable().default(null),

    /** When an officer records for a farmer. Requires `delegation`. */
    on_behalf_of: PartyId.nullable().default(null),
    delegation: DelegationId.nullable().default(null),

    device_id: z.string().nullable().default(null),

    /** Spec §8. Corrections are new records; nothing is ever updated. */
    supersedes: EventId.nullable().default(null),
    superseded_by: EventId.nullable().default(null),

    ext: Extensions.default({}),
  })
  .refine((e) => e.on_behalf_of === null || e.delegation !== null, {
    message:
      "on_behalf_of requires an active delegation — acting for another party without one is impersonation",
    path: ["delegation"],
  })
  .refine((e) => e.supersedes === null || e.supersedes !== e.id, {
    message: "a record cannot supersede itself",
    path: ["supersedes"],
  });

export type Envelope = z.infer<typeof Envelope>;

/**
 * The envelope fields as a plain shape, for composing into entity schemas.
 * The refinements above are re-applied by `factRecord` / `inferenceRecord`.
 */
export const envelopeShape = {
  id: EventId,
  type: z.string().min(1),
  record_class: RecordClass,
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver"),
  occurred_at: Timestamp,
  occurred_at_precision: OccurredAtPrecision,
  recorded_at: Timestamp,
  asserted_by: PartyId,
  authenticated_as: AccountId.nullable().default(null),
  on_behalf_of: PartyId.nullable().default(null),
  delegation: DelegationId.nullable().default(null),
  device_id: z.string().nullable().default(null),
  supersedes: EventId.nullable().default(null),
  superseded_by: EventId.nullable().default(null),
  ext: Extensions.default({}),
} as const;

const withEnvelopeInvariants = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  schema
    .refine(
      (e: Record<string, unknown>) =>
        e["on_behalf_of"] === null ||
        e["on_behalf_of"] === undefined ||
        (e["delegation"] !== null && e["delegation"] !== undefined),
      {
        message:
          "on_behalf_of requires an active delegation — acting for another party without one is impersonation",
        path: ["delegation"],
      },
    )
    .refine(
      (e: Record<string, unknown>) =>
        e["supersedes"] === null ||
        e["supersedes"] === undefined ||
        e["supersedes"] !== e["id"],
      { message: "a record cannot supersede itself", path: ["supersedes"] },
    );

/**
 * Compose an observation-class record: envelope + entity body, with
 * `record_class` pinned to "observation" and `type` pinned to the entity name.
 *
 * Pinning at the schema level is what makes it structurally impossible to write
 * a model output into the fact log — an Inference cannot satisfy this schema.
 */
export const factRecord = <S extends z.ZodRawShape>(
  typeName: string,
  body: S,
) =>
  withEnvelopeInvariants(
    z.object({
      ...envelopeShape,
      type: z.literal(typeName),
      record_class: z.literal("observation"),
      ...body,
    }),
  );

/** Compose an inference-class record. See §6 and inference.ts. */
export const inferenceRecord = <S extends z.ZodRawShape>(body: S) =>
  withEnvelopeInvariants(
    z.object({
      ...envelopeShape,
      type: z.literal("inference"),
      record_class: z.literal("inference"),
      ...body,
    }),
  );
