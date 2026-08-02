import { z } from "zod";

/**
 * Spec §2.2. No default, deliberately.
 *
 * Smallholders reliably know the week they planted; they do not know the hour.
 * Recording a precise instant for a remembered "sometime in the second week of
 * March" manufactures precision that every downstream analytic silently trusts.
 * Forcing the caller to state the precision is the whole point.
 */
export const OccurredAtPrecision = z.enum([
  "instant",
  "day",
  "week",
  "month",
  "season",
]);
export type OccurredAtPrecision = z.infer<typeof OccurredAtPrecision>;

/**
 * Spec §3.3 — the enum that turns records into credit signal.
 * Ordered weakest to strongest.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ There is deliberately NO value for model-derived or predicted.       │
 * │ A model output is not a measurement. It belongs in an Inference      │
 * │ record (§6) in a separate namespace.                                 │
 * │                                                                       │
 * │ Any pull request adding `model_estimated` here should be rejected.   │
 * │ It is the precise mechanism by which a data asset stops being        │
 * │ trustworthy: the model begins training on its own output, error      │
 * │ compounds silently, and lenders underwrite against figures they      │
 * │ believe were measured.                                                │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export const MEASUREMENT_METHODS = [
  "self_reported",
  "field_estimated",
  "coop_counted",
  "coop_weighed",
  "calibrated_weighed",
  "counterparty_confirmed",
  "third_party_verified",
] as const;

export const MeasurementMethod = z.enum(MEASUREMENT_METHODS);
export type MeasurementMethod = z.infer<typeof MeasurementMethod>;

/** Rank on the trust ladder. Higher is stronger evidence. */
export const methodStrength = (m: MeasurementMethod): number =>
  MEASUREMENT_METHODS.indexOf(m);

/**
 * A blended figure inherits its weakest component. A yield estimate combining
 * third-party-verified deliveries with self-reported harvests is a
 * self-reported figure, and must be presented as one.
 */
export const weakestMethod = (
  methods: readonly MeasurementMethod[],
): MeasurementMethod | undefined =>
  methods.length === 0
    ? undefined
    : methods.reduce((a, b) => (methodStrength(b) < methodStrength(a) ? b : a));

/** The threshold at or above which lenders will generally underwrite. */
export const UNDERWRITABLE_FROM: MeasurementMethod = "coop_weighed";

export const isUnderwritable = (m: MeasurementMethod): boolean =>
  methodStrength(m) >= methodStrength(UNDERWRITABLE_FROM);

/**
 * Spec §5.6. `held_by`, never `owned_by`.
 *
 * Land tenure in Uganda is frequently customary, rented, or borrowed, and much
 * of it is undocumented. Asserting ownership is a legal claim the platform
 * cannot substantiate and one that could cause real harm in a dispute.
 * `unknown` is legitimate and common — do not force a guess.
 */
export const Tenure = z.enum([
  "owned",
  "rented",
  "customary",
  "borrowed",
  "communal",
  "unknown",
]);
export type Tenure = z.infer<typeof Tenure>;

export const PartyKind = z.enum([
  "person",
  "cooperative",
  "business",
  "institution",
  "agency",
]);
export type PartyKind = z.infer<typeof PartyKind>;

export const AccountStatus = z.enum(["active", "suspended", "retired"]);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const MembershipRole = z.enum(["member", "officer", "agent", "supplier"]);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const FacilityKind = z.enum([
  "collection_point",
  "store",
  "warehouse",
  "weighbridge",
  "market",
  "processing",
  "dry_yard",
]);
export type FacilityKind = z.infer<typeof FacilityKind>;

/**
 * Spec §5.3. `organisational_bylaw` covers the common real case where
 * cooperative membership itself confers recording authority. It is weaker
 * evidence than an individual grant and must be labelled as such wherever
 * delegated records are surfaced.
 */
export const DelegationBasis = z.enum([
  "in_person_signature",
  "ussd_confirmation",
  "witnessed",
  "organisational_bylaw",
]);
export type DelegationBasis = z.infer<typeof DelegationBasis>;

export const AreaMethod = z.enum([
  "gps_walked",
  "map_traced",
  "declared",
  "derived_from_boundary",
]);
export type AreaMethod = z.infer<typeof AreaMethod>;

export const GeoSource = z.enum([
  "gps_device",
  "map_pin",
  "admin_centroid",
  "declared",
]);
export type GeoSource = z.infer<typeof GeoSource>;

export const ObservationMethod = z.enum([
  "lab_tested",
  "field_instrument",
  "visual",
  "reported",
  "survey",
]);
export type ObservationMethod = z.infer<typeof ObservationMethod>;

export const SubjectType = z.enum([
  "plot",
  "lot",
  "party",
  "facility",
  "region",
  "planting",
]);
export type SubjectType = z.infer<typeof SubjectType>;

/**
 * Spec §9. Attribution basis for a lot component.
 *
 * When forty farmers' maize is tipped into one store, physical traceability is
 * gone and cannot be recovered. Any lot with a non-`physical` component is
 * commingled, and every downstream traceability claim must degrade with it.
 */
export const AttributionBasis = z.enum(["physical", "proportional", "declared"]);
export type AttributionBasis = z.infer<typeof AttributionBasis>;

export const AgreementKind = z.enum([
  "spot",
  "forward",
  "contract_farming",
  "input_credit",
  "offtake",
]);
export type AgreementKind = z.infer<typeof AgreementKind>;

export const AgreementRole = z.enum([
  "supplier",
  "buyer",
  "financier",
  "guarantor",
]);
export type AgreementRole = z.infer<typeof AgreementRole>;

export const PriceBasis = z.enum(["fixed", "indexed", "floor"]);
export type PriceBasis = z.infer<typeof PriceBasis>;

export const ObligationKind = z.enum([
  "payment_for_goods",
  "loan_disbursement",
  "loan_repayment",
  "insurance_premium",
  "fee",
  "input_credit",
]);
export type ObligationKind = z.infer<typeof ObligationKind>;

/**
 * Spec §5.14. Settlement rails are all external.
 *
 * ClyCites is not a ledger of record for money and holds no funds. MTN, Airtel
 * and the commercial banks are the ledgers. Recording obligations and
 * referencing external settlements yields the repayment signal without pulling
 * the platform into Bank of Uganda licensing under the National Payment
 * Systems Act.
 */
export const SettlementRail = z.enum([
  "mtn_momo",
  "airtel_money",
  "bank_transfer",
  "cash",
  "in_kind",
  "offset",
]);
export type SettlementRail = z.infer<typeof SettlementRail>;

/** Open decision D10 — record the distinction before it is implementable. */
export const VerificationStatus = z.enum([
  "asserted",
  "provider_verified",
  "disputed",
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/**
 * Spec §4, §6. The discriminator that keeps the data asset trustworthy.
 * Observations and inferences are stored in separate namespaces, not merely
 * flagged. A default read of the fact log returns observations only.
 */
export const RecordClass = z.enum(["observation", "inference"]);
export type RecordClass = z.infer<typeof RecordClass>;

/** Local units. None of these are stable; all of them are what farmers say. */
export const RawUnit = z.enum([
  "kg",
  "tonne",
  "gram",
  "litre",
  "bag",
  "sack",
  "basin",
  "tin",
  "basket",
  "bunch",
  "heap",
  "wheelbarrow",
  "jerrycan",
  "piece",
]);
export type RawUnit = z.infer<typeof RawUnit>;

export const ConversionBasis = z.enum([
  "measured",
  "published_standard",
  "estimated",
  "assumed_default",
]);
export type ConversionBasis = z.infer<typeof ConversionBasis>;
