import { z } from "zod";

/**
 * Timestamps are RFC 3339 with an explicit offset. Spec §2.2.
 *
 * The offset is mandatory, not cosmetic: records are captured offline across
 * devices whose clocks and locales cannot be assumed, and a bare local
 * timestamp is unrecoverable after the fact.
 */
export const Timestamp = z.iso.datetime({ offset: true }).brand<"Timestamp">();
export type Timestamp = z.infer<typeof Timestamp>;

export const DateOnly = z.iso.date().brand<"DateOnly">();
export type DateOnly = z.infer<typeof DateOnly>;

/**
 * All identifiers are UUIDv7. Spec §2.1.
 *
 * Time-ordered and generable offline with no coordination — both properties are
 * load-bearing for a field device that may not reach a server for days.
 */
const uuidv7 = z.uuid({ version: "v7" });

/**
 * Branded per entity so the type system rejects passing a PlotId where a
 * PartyId is expected. At runtime these are all just UUIDv7 strings.
 */
const id = <B extends string>(brand: B) => uuidv7.brand<B>();

export const PartyId = id("PartyId");
export const AccountId = id("AccountId");
export const DelegationId = id("DelegationId");
export const MembershipId = id("MembershipId");
export const FacilityId = id("FacilityId");
export const PlotId = id("PlotId");
export const PlantingId = id("PlantingId");
export const HarvestId = id("HarvestId");
export const ObservationId = id("ObservationId");
export const LotId = id("LotId");
export const CustodyTransferId = id("CustodyTransferId");
export const DeliveryId = id("DeliveryId");
export const AgreementId = id("AgreementId");
export const ObligationId = id("ObligationId");
export const SettlementReferenceId = id("SettlementReferenceId");
export const InferenceId = id("InferenceId");
export const UnitConversionId = id("UnitConversionId");
export const EventId = id("EventId");

export type PartyId = z.infer<typeof PartyId>;
export type AccountId = z.infer<typeof AccountId>;
export type DelegationId = z.infer<typeof DelegationId>;
export type MembershipId = z.infer<typeof MembershipId>;
export type FacilityId = z.infer<typeof FacilityId>;
export type PlotId = z.infer<typeof PlotId>;
export type PlantingId = z.infer<typeof PlantingId>;
export type HarvestId = z.infer<typeof HarvestId>;
export type ObservationId = z.infer<typeof ObservationId>;
export type LotId = z.infer<typeof LotId>;
export type CustodyTransferId = z.infer<typeof CustodyTransferId>;
export type DeliveryId = z.infer<typeof DeliveryId>;
export type AgreementId = z.infer<typeof AgreementId>;
export type ObligationId = z.infer<typeof ObligationId>;
export type SettlementReferenceId = z.infer<typeof SettlementReferenceId>;
export type InferenceId = z.infer<typeof InferenceId>;
export type UnitConversionId = z.infer<typeof UnitConversionId>;
export type EventId = z.infer<typeof EventId>;

/**
 * Crop codes resolve against an external taxonomy. Open decision D1 — the
 * underlying standard is not yet chosen, so this is deliberately an opaque
 * namespaced string behind a ClyCites indirection layer rather than a closed
 * enum we would have to break later.
 */
export const CropCode = z
  .string()
  .regex(/^crop\.[a-z0-9_]+(\.[a-z0-9_]+)*$/, "expected crop.<name>[.<part>]")
  .brand<"CropCode">();
export type CropCode = z.infer<typeof CropCode>;

/**
 * Administrative region code carrying the vintage of the boundary set.
 * Open decision D6: Uganda's districts have subdivided repeatedly, so a bare
 * district code is ambiguous across time and historical geography breaks
 * without the vintage.
 */
export const AdminRegion = z.object({
  code: z.string().min(1),
  vintage: z.string().regex(/^\d{4}$/, "four-digit year of the boundary set"),
});
export type AdminRegion = z.infer<typeof AdminRegion>;

/**
 * Season label, e.g. "2026A" for the first rains. Distinguishes one harvest
 * cycle from the next in a bimodal rainfall system — without it a farmer with
 * two maize crops a year is indistinguishable from one with double the yield.
 */
export const SeasonLabel = z
  .string()
  .regex(/^\d{4}[A-C]$/, "expected e.g. 2026A")
  .brand<"SeasonLabel">();
export type SeasonLabel = z.infer<typeof SeasonLabel>;

/** Reverse-DNS namespaced extension bag. Spec §2.5, §11. Never validated by the kernel. */
export const Extensions = z.record(
  z.string().regex(/^[a-z]{2,}(\.[a-z0-9-]+)+$/, "expected reverse-DNS namespace"),
  z.unknown(),
);
export type Extensions = z.infer<typeof Extensions>;
