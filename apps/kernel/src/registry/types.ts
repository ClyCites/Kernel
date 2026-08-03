import { z } from 'zod';
import {
  ConversionBasis,
  ObservationMethod,
  RawUnit,
  SubjectType,
} from '@clycites/schema';

/**
 * Registry shapes that `@clycites/schema` deliberately does not define.
 *
 * The vendored schema is the only definition of an entity the kernel stores as
 * a record. These are not records — they are reference data. `observation_type`
 * is a namespaced string in the schema and `Grade.scheme` is opaque precisely
 * because *which* values are legal is a kernel concern, not a core-facts one.
 *
 * If a second consumer ever needs these, promote them to
 * `packages/registry-schema`. One consumer does not justify a package.
 */

/** Which `ObservationValue` variant an observation of this type must carry. */
export const ObservationValueKind = z.enum([
  'quantity',
  'scalar',
  'category',
  'boolean',
  'text',
]);
export type ObservationValueKind = z.infer<typeof ObservationValueKind>;

/**
 * `owner` is the party accountable for the entry. Open decision D8 is what
 * powers that ownership carries; the name is recorded either way, because an
 * unowned vocabulary grows entries nobody can retire.
 */
export const ObservationTypeEntry = z.object({
  code: z
    .string()
    .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'expected namespaced type'),
  version: z.int().positive(),
  label: z.string().min(1),
  unit: z.string().min(1).nullable(),
  value_kind: ObservationValueKind,
  permitted_methods: z.array(ObservationMethod).min(1),
  subject_types: z.array(SubjectType).min(1),
  owner: z.string().min(1),
  source: z.string().nullable(),
});
export type ObservationTypeEntry = z.infer<typeof ObservationTypeEntry>;

/**
 * Schemes are stored opaquely. `ordinal` orders values inside one scheme and
 * carries no meaning across schemes — UNBS Grade 1 and a buyer's Grade 1 are
 * different claims, and the kernel never ranks one against the other.
 */
export const GradingSchemeValue = z.object({
  scheme: z.string().min(1),
  value: z.string().min(1),
  label: z.string().nullable(),
  ordinal: z.int().nullable(),
});
export type GradingSchemeValue = z.infer<typeof GradingSchemeValue>;

export const GradingSchemeEntry = z.object({
  scheme: z.string().min(1),
  label: z.string().min(1),
  owner: z.string().min(1),
  source: z.string().nullable(),
});
export type GradingSchemeEntry = z.infer<typeof GradingSchemeEntry>;

/** One weighing behind a `measured` factor. */
export const ConversionSample = z.object({
  ordinal: z.int().positive(),
  weight_kg: z.number().positive(),
  condition: z.string().nullable(),
});
export type ConversionSample = z.infer<typeof ConversionSample>;

/** The stored form of `@clycites/schema`'s `UnitConversion`, plus its lineage. */
export const UnitConversionRow = z.object({
  id: z.uuid(),
  from_unit: RawUnit,
  to_unit: RawUnit,
  factor: z.number().positive(),
  commodity: z.string().nullable(),
  region_code: z.string().nullable(),
  region_vintage: z.string().nullable(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  basis: ConversionBasis,
  source: z.string().nullable(),
  supersedes: z.uuid().nullable(),
  /** What the factor was established from. Null on definitions and guesses. */
  sample_size: z.int().positive().nullable(),
  sample_min: z.number().nullable(),
  sample_max: z.number().nullable(),
  sample_stddev: z.number().nonnegative().nullable(),
  /** The state the commodity was in, e.g. `dried,tight`. */
  condition: z.string().nullable(),
  /** What the container is called locally, e.g. `kaveera`. */
  local_label: z.string().nullable(),
  /** A name or role, not a party id — the person holding the scale rarely is one. */
  measured_by: z.string().nullable(),
  measured_at: z.string().nullable(),
  instrument: z.string().nullable(),
});
export type UnitConversionRow = z.infer<typeof UnitConversionRow>;

/** A conversion with the weighings behind it. What the public endpoint serves. */
export interface UnitConversionDetail extends UnitConversionRow {
  sample: ConversionSample[];
}

export const CropCodeEntry = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  parent_code: z.string().nullable(),
  external_scheme: z.string().nullable(),
  external_code: z.string().nullable(),
});
export type CropCodeEntry = z.infer<typeof CropCodeEntry>;

export const AdminRegionEntry = z.object({
  code: z.string().min(1),
  vintage: z.string().regex(/^\d{4}$/),
  name: z.string().min(1),
  level: z.string().min(1),
  parent_code: z.string().nullable(),
  parent_vintage: z.string().nullable(),
  source: z.string().nullable(),
});
export type AdminRegionEntry = z.infer<typeof AdminRegionEntry>;

/**
 * What a `SeasonLabel` covers, per region. Work order M4.
 *
 * `SeasonLabel` stays an opaque string in `@clycites/schema`; resolution
 * happens here, so a field answer is an INSERT rather than a migration. Open
 * decision D5 — whose calendar wins when a cooperative disagrees with the
 * national one — is not closed by this shape, only kept answerable.
 *
 * `source` is not nullable. A season nobody can trace back is indistinguishable
 * from one somebody invented, and the database refuses a blank one.
 */
export const SeasonCalendarEntry = z.object({
  region_code: z.string().min(1),
  region_vintage: z.string().regex(/^\d{4}$/),
  label: z.string().min(1),
  starts_on: z.string(),
  ends_on: z.string(),
  basis: z.enum(['published', 'observed']),
  source: z.string().min(1),
  note: z.string().nullable(),
});
export type SeasonCalendarEntry = z.infer<typeof SeasonCalendarEntry>;
