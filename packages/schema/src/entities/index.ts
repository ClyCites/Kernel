import { z } from "zod";
import { factRecord } from "../envelope.js";
import {
  AccountId,
  AdminRegion,
  AgreementId,
  CropCode,
  DateOnly,
  DeliveryId,
  FacilityId,
  HarvestId,
  LotId,
  ObligationId,
  PartyId,
  PlantingId,
  PlotId,
  SeasonLabel,
  Timestamp,
} from "../primitives.js";
import {
  AccountStatus,
  AgreementKind,
  AgreementRole,
  AttributionBasis,
  DelegationBasis,
  FacilityKind,
  MembershipRole,
  ObligationKind,
  ObservationMethod,
  PartyKind,
  PriceBasis,
  SettlementRail,
  SubjectType,
  Tenure,
  VerificationStatus,
} from "../enums.js";
import {
  Area,
  Contact,
  GeoPoint,
  Grade,
  Identifier,
  MediaRef,
  Money,
  Quantity,
} from "../values.js";

/* ── Trust and identity ───────────────────────────────────────────────── */

/**
 * Spec §5.1. A Party is a subject in the world, not a login.
 *
 * Many parties never authenticate at all. A farmer enrolled on paper by a coop
 * officer is a full Party with no credentials and must remain so — requiring a
 * login to exist excludes exactly the population the platform serves.
 *
 * NIN is one identifier among several, not the key. A meaningful share of
 * smallholders will not have a National ID to hand at enrolment.
 */
export const Party = factRecord("party", {
  kind: PartyKind,
  display_name: z.string().min(1),
  identifiers: z.array(Identifier).default([]),
  contacts: z.array(Contact).default([]),
  primary_region: AdminRegion.nullable().default(null),
});
export type Party = z.infer<typeof Party>;

/** Spec §5.2. An authenticated principal. Credentials and sessions attach here. */
export const Account = factRecord("account", {
  account_id: AccountId,
  primary_party: PartyId,
  auth_subject: z.string().min(1),
  status: AccountStatus,
});
export type Account = z.infer<typeof Account>;

/**
 * Spec §5.3. Authority for one party to assert records on behalf of another.
 *
 * Distinct from consent. Delegation is authority to ACT; consent is authority
 * to SHARE. A coop officer entitled to record a farmer's delivery is not
 * thereby entitled to disclose it to a lender.
 */
export const Delegation = factRecord("delegation", {
  delegator: PartyId,
  delegate: PartyId,
  /** Record types covered. Open decision D7: per type, not per field. */
  scope: z.array(z.string().min(1)).min(1),
  granted_at: Timestamp,
  expires_at: Timestamp.nullable().default(null),
  granted_via: DelegationBasis,
  evidence: z.array(MediaRef).default([]),
  revoked_at: Timestamp.nullable().default(null),
});
export type Delegation = z.infer<typeof Delegation>;

/**
 * Spec §5.4. Time-bounded. A farmer's deliveries three seasons ago remain valid
 * history after they leave, and any consumer computing "current members" must
 * respect `left_at`.
 */
export const Membership = factRecord("membership", {
  member: PartyId,
  organisation: PartyId,
  role: MembershipRole,
  joined_at: DateOnly.nullable().default(null),
  left_at: DateOnly.nullable().default(null),
});
export type Membership = z.infer<typeof Membership>;

/* ── Places and land ──────────────────────────────────────────────────── */

/** Spec §5.5. Referenced but undefined in v0.1 of the specification. */
export const Facility = factRecord("facility", {
  kind: FacilityKind,
  operated_by: PartyId,
  location: GeoPoint,
  admin_region: AdminRegion,
  capacity: Quantity.nullable().default(null),
});
export type Facility = z.infer<typeof Facility>;

/**
 * Spec §5.6. `held_by`, never `owned_by`.
 *
 * The schema records who works the land and states the tenure basis
 * separately. Asserting ownership is a legal claim the platform cannot
 * substantiate and one that could cause real harm if surfaced in a dispute.
 */
export const Plot = factRecord("plot", {
  held_by: PartyId,
  tenure: Tenure,
  centroid: GeoPoint,
  boundary: z
    .array(z.tuple([z.number(), z.number()]))
    .min(4)
    .nullable()
    .default(null),
  area: Area,
  admin_region: AdminRegion,
  local_name: z.string().nullable().default(null),
});
export type Plot = z.infer<typeof Plot>;

/* ── Production ───────────────────────────────────────────────────────── */

export const Planting = factRecord("planting", {
  plot: PlotId,
  crop: CropCode,
  /** Free text initially — varietal naming is not standardised in practice. */
  variety: z.string().nullable().default(null),
  season: SeasonLabel,
  area_planted: Area,
});
export type Planting = z.infer<typeof Planting>;

/**
 * Spec §5.8. A claim about production. Almost always self-reported.
 *
 * `planting` is nullable because harvests will frequently be recorded for plots
 * where no planting was captured — retrofitting onto a season already underway
 * is the normal case, not the exception.
 */
export const Harvest = factRecord("harvest", {
  planting: PlantingId.nullable().default(null),
  plot: PlotId,
  crop: CropCode,
  quantity: Quantity,
  grade: Grade.nullable().default(null),
});
export type Harvest = z.infer<typeof Harvest>;

/**
 * Spec §5.9. A typed measurement about a subject.
 *
 * This one entity replaces what would otherwise be four or five bespoke ones —
 * soil tests, grain moisture, pest sightings, and market price surveys are all
 * the same shape. Adding a new `observation_type` is a registry entry, not a
 * schema change.
 *
 * Weather is deliberately excluded: it is reference data keyed by geography and
 * time, joinable at read time. A farmer reporting hail IS an observation; the
 * daily rainfall grid is not.
 */
export const ObservationValue = z.union([
  z.object({ kind: z.literal("quantity"), value: Quantity }),
  z.object({
    kind: z.literal("scalar"),
    value: z.number(),
    unit: z.string().min(1),
  }),
  z.object({ kind: z.literal("category"), value: z.string().min(1) }),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  z.object({ kind: z.literal("text"), value: z.string() }),
]);
export type ObservationValue = z.infer<typeof ObservationValue>;

export const Observation = factRecord("observation", {
  subject_type: SubjectType,
  subject_ref: z.uuid({ version: "v7" }),
  /** Namespaced, e.g. soil.ph, moisture.grain_pct, pest.incidence. */
  observation_type: z
    .string()
    .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, "expected namespaced type"),
  value: ObservationValue,
  method: ObservationMethod,
  instrument: z.string().nullable().default(null),
  media: z.array(MediaRef).default([]),
});
export type Observation = z.infer<typeof Observation>;

/* ── Trade ────────────────────────────────────────────────────────────── */

/** Spec §9. Attribution degrades when produce is commingled. */
export const LotComponent = z.object({
  source_ref: z.uuid({ version: "v7" }),
  source_type: z.enum(["harvest", "lot"]),
  quantity: Quantity,
  basis: AttributionBasis,
});
export type LotComponent = z.infer<typeof LotComponent>;

export const Lot = factRecord("lot", {
  commodity: CropCode,
  quantity: Quantity,
  /** Derived convenience field. Authoritative history is CustodyTransfer. */
  custodian: PartyId,
  location: z.union([FacilityId, GeoPoint]),
  composed_of: z.array(LotComponent).default([]),
  grade: Grade.nullable().default(null),
});
export type Lot = z.infer<typeof Lot>;

/**
 * Custody and ownership are different and frequently held by different parties.
 * A transporter carrying a coop's maize has custody without ownership, and the
 * gap between two custody transfers is exactly where losses occur.
 */
export const CustodyTransfer = factRecord("custody_transfer", {
  lot: LotId,
  from_party: PartyId,
  to_party: PartyId,
  location: z.union([FacilityId, GeoPoint]),
  quantity: Quantity,
  evidence: z.array(MediaRef).default([]),
});
export type CustodyTransfer = z.infer<typeof CustodyTransfer>;

/**
 * Spec §5.11. The commercially significant entity, and the one lenders
 * underwrite against.
 *
 * `quantity` is measured at the point of transfer, not inherited from the lot.
 * The two will differ — moisture loss, spillage, disputed weights, deliberate
 * shorting — and that difference is signal, not error.
 *
 * `counterparty_confirmed_at` is the most valuable nullable field in the
 * schema. A delivery affirmed independently by both sides is underwritable
 * evidence; one affirmed by neither is a story. The entire credit thesis
 * reduces to how large a corpus of two-sided confirmations can be accumulated.
 */
export const Delivery = factRecord("delivery", {
  from_party: PartyId,
  to_party: PartyId,
  lot: LotId.nullable().default(null),
  fulfils: AgreementId.nullable().default(null),
  commodity: CropCode,
  quantity: Quantity,
  grade: Grade.nullable().default(null),
  location: z.union([FacilityId, GeoPoint]),
  agreed_price: Money.nullable().default(null),
  counterparty_confirmed_at: Timestamp.nullable().default(null),
  counterparty_confirmed_by: PartyId.nullable().default(null),
  evidence: z.array(MediaRef).default([]),
});
export type Delivery = z.infer<typeof Delivery>;

/**
 * Spec §5.12. A commitment to transact in future.
 *
 * A forward commitment from a creditworthy buyer converts an unsecured loan to
 * a farmer into a receivable against an offtaker — which is why this is core
 * rather than marketplace-local state. Listings and bids stay in the app.
 *
 * Fulfilment is computed, not stored: sum the deliveries whose `fulfils`
 * points here.
 */
export const AgreementParty = z.object({
  party: PartyId,
  role: AgreementRole,
});

export const PriceTerms = z.object({
  basis: PriceBasis,
  value: Money.nullable().default(null),
  index_ref: z.string().nullable().default(null),
});

export const Agreement = factRecord("agreement", {
  kind: AgreementKind,
  parties: z.array(AgreementParty).min(2),
  commodity: CropCode,
  quantity_committed: Quantity,
  price_terms: PriceTerms,
  delivery_window: z.object({ from: Timestamp, to: Timestamp }),
  season: SeasonLabel.nullable().default(null),
  agreed_at: Timestamp,
  evidence: z.array(MediaRef).default([]),
});
export type Agreement = z.infer<typeof Agreement>;

/* ── Money — recorded, never held ─────────────────────────────────────── */

/** Spec §5.13. Money owed. Not money moved. */
export const Obligation = factRecord("obligation", {
  kind: ObligationKind,
  obligor: PartyId,
  obligee: PartyId,
  amount: Money,
  due_at: Timestamp.nullable().default(null),
  arising_from: z.union([DeliveryId, AgreementId]),
});
export type Obligation = z.infer<typeof Obligation>;

/**
 * Spec §5.14. Evidence that an obligation was settled SOMEWHERE ELSE.
 *
 * ClyCites is not a ledger of record for money and holds no funds. MTN, Airtel
 * and the commercial banks are the ledgers. Recording obligations and
 * referencing external settlements yields the repayment signal — the most
 * predictive variable in lending anywhere — with none of the custody, and
 * without triggering Bank of Uganda licensing under the National Payment
 * Systems Act.
 *
 * There is deliberately no Wallet, no Balance, and no Account holding funds.
 */
export const SettlementReference = factRecord("settlement_reference", {
  obligation: ObligationId,
  amount: Money,
  settled_at: Timestamp,
  rail: SettlementRail,
  external_ref: z.string().nullable().default(null),
  verification_status: VerificationStatus.default("asserted"),
  confirmed_by: PartyId.nullable().default(null),
  evidence: z.array(MediaRef).default([]),
});
export type SettlementReference = z.infer<typeof SettlementReference>;

/* ── Lineage ──────────────────────────────────────────────────────────── */

/** Spec §8.1. Excluded from default reads, retained in the log. */
export const Retraction = factRecord("retraction", {
  target: z.uuid({ version: "v7" }),
  reason_code: z.enum([
    "test_entry",
    "wrong_subject",
    "duplicate",
    "consent_withdrawn",
    "other",
  ]),
  note: z.string().nullable().default(null),
});
export type Retraction = z.infer<typeof Retraction>;

export const CORE_ENTITIES = [
  "party",
  "account",
  "delegation",
  "membership",
  "facility",
  "plot",
  "planting",
  "harvest",
  "observation",
  "lot",
  "custody_transfer",
  "delivery",
  "agreement",
  "obligation",
  "settlement_reference",
  "retraction",
] as const;

export type CoreEntityType = (typeof CORE_ENTITIES)[number];
