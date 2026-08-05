import { z } from "zod";
import { inferenceRecord } from "./envelope.js";
import { EventId } from "./primitives.js";
import { SubjectType } from "./enums.js";

/**
 * Spec §6. Inference is a SEPARATE RECORD CLASS, not a flag on a fact.
 *
 * The AI Agriculture Engine produces yield predictions, disease diagnoses,
 * planting recommendations and market forecasts. None of these are facts.
 *
 * Three failures follow from letting them into the fact log, in order of
 * severity:
 *
 *   1. Training on your own output. Within a season the model learns from its
 *      own predictions; error compounds silently while confidence does not.
 *   2. Contaminated credit decisions. A lender underwrites against a figure
 *      believing it measured, when it was estimated by a model that was itself
 *      trained on estimates.
 *   3. Unfalsifiable analytics. Once predictions are in the fact log there is
 *      no clean corpus left to evaluate the model against.
 *
 * This module exists so that (1) is structurally impossible rather than a
 * matter of discipline. An Inference cannot satisfy any entity schema in
 * entities/index.ts, because `record_class` and `type` are pinned literals.
 */

export const InferenceOutput = z.union([
  z.object({
    kind: z.literal("scalar"),
    value: z.number(),
    unit: z.string().min(1),
  }),
  z.object({
    kind: z.literal("category"),
    value: z.string().min(1),
    alternatives: z
      .array(z.object({ value: z.string(), probability: z.number().min(0).max(1) }))
      .default([]),
  }),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  z.object({
    kind: z.literal("range"),
    low: z.number(),
    high: z.number(),
    unit: z.string().min(1),
  }),
]);
export type InferenceOutput = z.infer<typeof InferenceOutput>;

export const Inference = inferenceRecord({
  model_id: z.string().min(1),
  model_version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver"),

  /** Namespaced, e.g. yield.predicted, disease.diagnosed, price.forecast. */
  inference_type: z
    .string()
    .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, "expected namespaced type"),

  subject_type: SubjectType,
  subject_ref: z.uuid({ version: "v7" }),

  /**
   * The exact records this was computed from. Mandatory and complete — an
   * inference that cannot name its inputs is not reproducible and should not
   * be written.
   */
  inputs: z.array(EventId).min(1),

  output: InferenceOutput,
  confidence: z.number().min(0).max(1).nullable().default(null),

  /**
   * 0 if every input is an observation; otherwise 1 + the maximum depth of the
   * inputs. A model consuming another model's output is where compounding
   * error lives; the field exists to make that visible and auditable rather
   * than accidental.
   */
  inference_depth: z.int().min(0),

  /**
   * Spec §6.3. Set later, when reality settles the question — a March yield
   * prediction linked in August to the deliveries that actually happened.
   *
   * The prediction never becomes a fact; it acquires a verdict. That linkage
   * is the entire evaluation dataset, and it is worth more than the model.
   * It is close to impossible to reconstruct retroactively, so it must be
   * designed for from the first inference written.
   */
  validated_by: z.array(EventId).default([]),
});

/**
 * v0.3 removed a `stale` boolean from this body. Spec §8 rule 5 says
 * superseding an observation "sets `stale`" on the inferences computed from
 * it, and in an append-only log nothing is ever set: correcting the flag would
 * take a second record asserting the first is stale, which is a fact about our
 * bookkeeping rather than about the world, and it would be wrong again the
 * moment another input moved. Staleness is a function of the inputs' current
 * tips, so the kernel derives it on every read and discards any value supplied
 * on ingest. It was never read in two years of the field being there. A field
 * that is always computed and never trusted is not part of the record.
 */

export type Inference = z.infer<typeof Inference>;

export const MAX_RECOMMENDED_INFERENCE_DEPTH = 1;

/**
 * Depth beyond 1 requires justification. Not an error — some pipelines
 * legitimately chain — but it must be a deliberate, reviewed choice.
 */
export const exceedsRecommendedDepth = (i: { inference_depth: number }): boolean =>
  i.inference_depth > MAX_RECOMMENDED_INFERENCE_DEPTH;

/**
 * Guard for the training pipeline. Spec §6.2 rule 3: inferences are excluded
 * from training corpora by default, and including them requires an explicit,
 * logged, reviewed exception.
 */
export const isTrainingEligible = (r: { record_class: string }): boolean =>
  r.record_class === "observation";
