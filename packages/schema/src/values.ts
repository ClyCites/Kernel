import { z } from "zod";
import {
  AdminRegion,
  CropCode,
  DateOnly,
  PartyId,
  Timestamp,
  UnitConversionId,
} from "./primitives.js";
import {
  AreaMethod,
  ConversionBasis,
  GeoSource,
  MeasurementMethod,
  RawUnit,
} from "./enums.js";

/**
 * Spec §3.5. Integer minor units, never floats.
 *
 * Binary floating point cannot represent decimal currency exactly and the
 * errors accumulate silently across aggregation. UGX has no minor unit in
 * practice; store it as minor units anyway with an implied exponent of 0 so
 * the type is uniform across currencies.
 */
export const Money = z.object({
  amount_minor: z.int(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/, "ISO 4217"),
});
export type Money = z.infer<typeof Money>;

/**
 * Spec §3.2. A first-class versioned entity, not a config file.
 *
 * `basis: "assumed_default"` is a debt marker. The share of normalized tonnage
 * resting on assumed conversions is a direct measure of how much the data can
 * be trusted.
 */
export const UnitConversion = z.object({
  id: UnitConversionId,
  from_unit: RawUnit,
  to_unit: RawUnit,
  factor: z.number().positive(),
  commodity: CropCode.nullable(),
  region: AdminRegion.nullable(),
  valid_from: DateOnly.nullable(),
  valid_to: DateOnly.nullable(),
  basis: ConversionBasis,
  source: z.string().nullable(),
});
export type UnitConversion = z.infer<typeof UnitConversion>;

/**
 * Spec §3.1. A quantity is never a bare number. The single most consequential
 * rule in the specification.
 *
 * `conversion_id` is a reference to a versioned conversion record, never an
 * inline factor. A "bag" of maize is not a fixed weight anywhere in Uganda —
 * it varies by district, by buyer, by packing, and by year. When the Kapchorwa
 * bag turns out to be 118kg rather than the assumed 100kg, every affected
 * `normalized_kg` is re-derived from the preserved `raw_value`. Store only the
 * normalized figure and the original observation is gone forever.
 */
export const Quantity = z
  .object({
    raw_value: z.number().positive(),
    raw_unit: RawUnit,
    /** Local vernacular term as actually spoken — kaveera, debe, and so on. */
    raw_unit_label: z.string().nullable().default(null),
    normalized_kg: z.number().positive().nullable().default(null),
    conversion_id: UnitConversionId.nullable().default(null),
    measurement_method: MeasurementMethod,
    quality_flags: z.array(z.string()).default([]),
  })
  .refine(
    (q) => q.normalized_kg === null || q.conversion_id !== null || q.raw_unit === "kg",
    {
      message:
        "normalized_kg requires a conversion_id (or a raw_unit already in kg) — an inline conversion is unauditable and cannot be re-derived",
      path: ["conversion_id"],
    },
  );
export type Quantity = z.infer<typeof Quantity>;

/**
 * Spec §3.4. Never a bare string.
 *
 * "Grade 1" is meaningless without knowing whose grading scheme. Schemes differ
 * between UNBS, individual buyers, WFP, and export markets. The kernel stores
 * `scheme` opaquely and never attempts cross-scheme comparison — that is an
 * application concern.
 */
export const Grade = z.object({
  scheme: z.string().min(1),
  value: z.string().min(1),
  assessed_by: PartyId,
  method: z.string().min(1),
});
export type Grade = z.infer<typeof Grade>;

/**
 * Spec §3.6. `accuracy_m` is what lets a consumer decide whether two points are
 * the same plot. Discarding it discards the ability to reason about the
 * geometry at all.
 */
export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy_m: z.number().positive().nullable().default(null),
  /** A point captured six months ago in an office is not a plot location. */
  captured_at: Timestamp.nullable().default(null),
  source: GeoSource,
});
export type GeoPoint = z.infer<typeof GeoPoint>;

/**
 * Spec §3.7. `declared` will be the overwhelming majority and that is
 * acceptable. Labelling it as declared is what makes it acceptable.
 */
export const Area = z.object({
  value: z.number().positive(),
  unit: z.enum(["hectare", "acre", "local"]),
  local_unit_label: z.string().nullable().default(null),
  method: AreaMethod,
});
export type Area = z.infer<typeof Area>;

/** Spec §3.8. An identifier is an attested claim, not a property. */
export const Identifier = z.object({
  scheme: z.string().min(1),
  value: z.string().min(1),
  attested_by: PartyId,
  attested_at: Timestamp,
});
export type Identifier = z.infer<typeof Identifier>;

/**
 * Spec §5.1. Phone is a contact channel with a verification timestamp, never a
 * primary or natural key. SIM cards are shared between household members,
 * swapped, lost, and recycled by operators. Systems that key on phone number
 * silently merge unrelated farmers and split single farmers into many.
 */
export const Contact = z.object({
  channel: z.enum(["phone", "sms", "ussd", "email", "whatsapp"]),
  value: z.string().min(1),
  verified_at: Timestamp.nullable().default(null),
});
export type Contact = z.infer<typeof Contact>;

/**
 * Spec §3.9. Content-addressed on purpose: the hash is what gets anchored, so a
 * photograph attached to a delivery dispute is provably the same photograph six
 * months later. Bytes live in object storage; only the hash and locator are in
 * the kernel.
 *
 * `metadata_stripped` is a privacy control, not a technical detail. Phone
 * photographs carry GPS coordinates and device identifiers by default, and a
 * disease photo silently disclosing a farmer's homestead location to a third
 * party is a data protection incident.
 */
export const MediaRef = z.object({
  content_hash: z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256"),
  mime_type: z.string().min(1),
  byte_size: z.int().positive(),
  storage_ref: z.string().min(1),
  captured_at: Timestamp.nullable().default(null),
  captured_by: PartyId,
  capture_location: GeoPoint.nullable().default(null),
  metadata_stripped: z.boolean(),
});
export type MediaRef = z.infer<typeof MediaRef>;

export { AdminRegion };
