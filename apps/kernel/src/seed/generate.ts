import { SCHEMA_VERSION } from '@clycites/schema';
import type { LawfulBasis } from '../records/lawful-basis.js';
import { appendAdversarial } from './adversarial.js';
import {
  ACRE_IN_HA,
  COOPS,
  CONVERSIONS,
  COOP_A_SAMPLE,
  FAMILY_NAMES,
  GIVEN_NAMES,
  HARVEST_YIELD_SPREAD,
  SEASON,
  VARIETIES,
  yieldFor,
  type CoopFixture,
  type YieldProfile,
} from './fixtures.js';
import { at, DEFAULT_SEED, IdFactory, Rng, round } from './random.js';

/**
 * The adversarial seed corpus. Work order D.
 *
 * This file decides *what* to write; `write.ts` decides how. Keeping them apart
 * means the plan can be inspected, diffed and asserted against without a
 * database — which is what makes D1's determinism claim checkable.
 */

export type Expectation = 'accepted' | 'rejected';

export type Push = (
  document: Record<string, unknown>,
  basis: LawfulBasis,
  expect?: Expectation,
  note?: string,
) => string;

export interface Envelope {
  id: string;
  type: string;
  occurredAt: string;
  assertedBy: string;
  precision?: string;
  onBehalfOf?: string;
  delegation?: string;
  supersedes?: string;
  clientRecordedAt?: string;
}

export interface SeedWrite {
  document: Record<string, unknown>;
  basis: LawfulBasis;
  expect: Expectation;
  /** Why this write exists. Present on every deliberate failure. */
  note?: string;
}

export interface FarmerRef {
  id: string;
  name: string;
  coop: CoopFixture['key'];
  hasNin: boolean;
}

export interface DeliveryRecord {
  id: string;
  farmer: string;
  coop: CoopFixture['key'];
  normalizedKg: number;
  day: number;
}

export interface LotRecord {
  id: string;
  coop: CoopFixture['key'];
  openingKg: number;
}

/**
 * A consent grant the seed asks the kernel to record, as the subject.
 *
 * Deliberately narrow and deliberately uneven. A corpus where every grant
 * covers everything demonstrates nothing: the interesting property of the
 * consent module is what it refuses, and the refusals only appear if some
 * grants stop short.
 */
export interface SeedGrant {
  subject: string;
  grantee: string;
  purpose: string;
  record_types: string[];
  expires_at: string | null;
  granted_via: string;
  /** Why this grant exists, for the report to print beside it. */
  note: string;
}

export interface SeedPlan {
  seed: number;
  /** Which yield table the harvests came from. Printed on every artifact. */
  profile: YieldProfile;
  writes: SeedWrite[];
  farmers: FarmerRef[];
  coopParties: Record<CoopFixture['key'], string>;
  /** The third party the lender view is rendered as. */
  lender: string;
  /**
   * Grants posted after the records, because a grant names a subject and a
   * grantee and neither exists until their party record does.
   */
  grants: SeedGrant[];
  /** Ids the assertions need to find again. */
  markers: {
    supersededDelivery: string;
    supersedingDelivery: string;
    forkParent: string;
    forkLeft: string;
    forkRight: string;
    retractedDelivery: string;
    retraction: string;
    scopeMismatchDelivery: string;
    regionUnresolvableDelivery: string;
    unresolvedDeliveries: string[];
    partiallyFulfilledAgreement: string;
    /** Coop A's forward, whose fulfilment is polluted by the fork. */
    forkAgreement: string;
    overDeliveredAgreement: string;
    partiallySettledObligation: string;
    unsettledObligation: string;
    inference: string;
    lenderFarmerA: string;
    lenderFarmerC: string;
  };
}

/* ── envelope helpers ─────────────────────────────────────────────────── */

export const envelope = (
  e: Envelope,
  body: Record<string, unknown>,
): Record<string, unknown> => ({
  id: e.id,
  type: e.type,
  record_class: 'observation',
  schema_version: SCHEMA_VERSION,
  occurred_at: e.occurredAt,
  occurred_at_precision: e.precision ?? 'day',
  asserted_by: e.assertedBy,
  ...(e.onBehalfOf ? { on_behalf_of: e.onBehalfOf } : {}),
  ...(e.delegation ? { delegation: e.delegation } : {}),
  ...(e.supersedes ? { supersedes: e.supersedes } : {}),
  ...(e.clientRecordedAt ? { client_recorded_at: e.clientRecordedAt } : {}),
  ...body,
});

const geoPoint = (rng: Rng, lat: number, lon: number, capturedAt: string) => ({
  lat: round(lat + rng.normal(0, 0.02), 5),
  lon: round(lon + rng.normal(0, 0.02), 5),
  accuracy_m: rng.int(4, 30),
  captured_at: capturedAt,
  source: 'gps_device',
});

/**
 * A quantity already in kilograms. `conversion_id` is null and the refinement
 * allows it precisely because there is nothing to re-derive: kg is kg.
 */
export const kg = (value: number, method = 'calibrated_weighed') => ({
  raw_value: value,
  raw_unit: 'kg',
  raw_unit_label: null,
  normalized_kg: value,
  conversion_id: null,
  measurement_method: method,
});

/** District centroids, so plots in one coop cluster where they should. */
const CENTROIDS: Record<CoopFixture['key'], { lat: number; lon: number }> = {
  A: { lat: -0.3341, lon: 31.7343 },
  B: { lat: 1.8874, lon: 32.0637 },
  C: { lat: 1.3967, lon: 34.4506 },
  D: { lat: 2.4757, lon: 31.089 },
};

/** Well-formed, and deliberately not in `registry.unit_conversion`. */
export const UNRESOLVED_CONVERSION = '019fc600-0000-7000-8000-0000000009ff';

/**
 * The season calendar, as day offsets from `EPOCH` (1 January 2026).
 *
 * Work order M2. The agronomic dates are Uganda's 2026 first season as reported
 * by the FAO GIEWS country brief of 8 May 2026: in the bimodal rainfall areas
 * that cover most of the country, first-season crops "were planted in February
 * and March 2026, and will be harvested in June and July". The same statement
 * seeds `registry.season_calendar` in migration 0018, so the corpus and the
 * registry cannot drift apart silently.
 *
 * The post-harvest chain is compressed against that calendar for a reason that
 * is not agronomic: `occurred_at` later than the server's clock raises
 * `occurred_after_recorded`, and a corpus where *every* record carries that flag
 * proves nothing. So the whole sequence has to close before the corpus is run,
 * and `settlement` is the last date that fits. The deliberate clock-skew cases
 * below are the only ones that cross the line, and they cross it by years so the
 * assertion cannot rot into a false pass.
 */
export const DAY = {
  registration: 0,
  /** Signed before planting, which is what makes it a forward. */
  agreement: 30,
  /** GIEWS: planted February and March. */
  planting: 45,
  /** GIEWS: harvested in June and July. */
  harvest: 165,
  deliveryFirst: 170,
  deliverySpan: 30,
  lot: 202,
  transferOut: 203,
  loss: 204,
  transferIn: 205,
  obligation: 206,
  settlement: 208,
  /** A handset whose clock was never set. Deliberately far future. */
  brokenClock: 2000,
} as const;

/**
 * The quantity a coop's app would produce. Note what is *not* here: no
 * knowledge of what the container really holds. Coop C's app is not lying, it
 * is applying the only factor anyone ever gave it.
 */
const quantityFor = (
  coop: CoopFixture,
  bags: number,
  method = coop.key === 'A' ? 'coop_weighed' : 'coop_counted',
) => ({
  raw_value: bags,
  raw_unit: coop.rawUnit,
  raw_unit_label: coop.rawUnitLabel,
  normalized_kg: round(bags * coop.factor, 3),
  conversion_id: coop.conversionId ?? UNRESOLVED_CONVERSION,
  measurement_method: method,
});

/**
 * The same load, but weighed on the buyer's platform scale instead of counted.
 *
 * The officer types in what the scale said and leaves the conversion the app
 * has always cited. Now `raw_value × factor` and `normalized_kg` disagree, and
 * that disagreement is `conversion_mismatch` — the only signal in a single
 * record that says the factor is wrong. Coop C's whole problem, made legible
 * one delivery at a time.
 */
const weighedAgainstTheWrongFactor = (coop: CoopFixture, bags: number) => ({
  raw_value: bags,
  raw_unit: coop.rawUnit,
  raw_unit_label: coop.rawUnitLabel,
  normalized_kg: round(bags * coop.bagMean, 3),
  conversion_id: coop.conversionId ?? UNRESOLVED_CONVERSION,
  measurement_method: 'calibrated_weighed',
});

/**
 * How many containers came off a plot, from the area planted and the published
 * national yield for the crop. Work order M2.
 *
 * The count is in *real* containers — `bagMean`, what the thing actually holds
 * — not in what the coop's app thinks it holds. That is what keeps coop C's
 * error an error: its records claim `bags × 100` for containers of 118 kg, and
 * the difference has to survive the change of source or the corpus stops
 * proving anything.
 */
function harvestBagsFor(
  coop: CoopFixture,
  plantedAcres: number,
  rng: Rng,
  profile: YieldProfile,
): number {
  const yieldKgPerHa = yieldFor(profile, coop.commodity);
  if (yieldKgPerHa === undefined) {
    throw new Error(`no published yield for ${coop.commodity}`);
  }
  const variation = rng.normalWithin(
    1,
    HARVEST_YIELD_SPREAD.stddev,
    HARVEST_YIELD_SPREAD.min,
    HARVEST_YIELD_SPREAD.max,
  );
  const kg = plantedAcres * ACRE_IN_HA * yieldKgPerHa * variation;
  return Math.max(1, Math.round(kg / coop.bagMean));
}

/* ── the plan ─────────────────────────────────────────────────────────── */

/**
 * What the two farmers and their cooperatives actually permitted. Work order P2.
 *
 * Four grants and four deliberate holes. The report is only worth showing if
 * the lender is refused something, and each of these refusals is one a real
 * subject would plausibly impose:
 *
 * - Farmer C permits their deliveries and not their party record. Volumes for
 *   underwriting, no national ID. That is the commonest shape a farmer would
 *   choose if anybody asked them, and nobody usually does.
 * - Coop C permits nothing. Its lot is the record that exposes its own bag
 *   error, and an organisation declining to hand a lender the evidence against
 *   itself is not a hypothetical.
 * - Nobody granted `harvest`, `observation` or `agreement`. A grant enumerates
 *   record types, so everything not enumerated is refused by omission rather
 *   than by a rule somebody had to remember to write.
 * - No grant runs past the season. Consent with no end is consent nobody
 *   revisits.
 */
function lenderGrants(
  lender: string,
  farmerA: string,
  farmerC: string,
  coopParties: Record<CoopFixture['key'], string>,
): SeedGrant[] {
  const expires = at(DAY.harvest + 120);
  const grant = (
    subject: string,
    recordTypes: string[],
    grantedVia: string,
    note: string,
  ): SeedGrant => ({
    subject,
    grantee: lender,
    purpose: 'credit_assessment',
    record_types: recordTypes,
    expires_at: expires,
    granted_via: grantedVia,
    note,
  });

  return [
    grant(
      farmerA,
      ['party', 'delivery'],
      'in_person_signature',
      'signed at the coop office when the loan application was taken',
    ),
    grant(
      farmerC,
      ['delivery'],
      'ussd_confirmation',
      'confirmed by USSD; declined to include the party record, so no identity',
    ),
    grant(
      coopParties.A,
      ['lot', 'delivery'],
      'witnessed',
      'the cooperative permits its own lot and the deliveries it received; a delivery names two parties and needs both',
    ),
    grant(
      coopParties.C,
      ['lot', 'delivery'],
      'witnessed',
      'permits its own lot and deliveries, which is how its mass balance became checkable by somebody other than itself',
    ),
  ];
}

export function generate(
  seed: number = DEFAULT_SEED,
  profile: YieldProfile = 'faostat',
): SeedPlan {
  const rng = new Rng(seed);
  const ids = new IdFactory(rng);
  const writes: SeedWrite[] = [];
  const farmers: FarmerRef[] = [];

  const push = (
    document: Record<string, unknown>,
    basis: LawfulBasis,
    expect: Expectation = 'accepted',
    note?: string,
  ): string => {
    writes.push({ document, basis, expect, ...(note ? { note } : {}) });
    return document['id'] as string;
  };

  /* Parties: coops, their officers, buyers, transporters. */

  const coopParties = {} as Record<CoopFixture['key'], string>;
  const officers = {} as Record<CoopFixture['key'], string>;
  const buyers = {} as Record<CoopFixture['key'], string>;
  const transporters = {} as Record<CoopFixture['key'], string>;
  const facilities = {} as Record<CoopFixture['key'], string>;
  const lender = ids.next();

  for (const coop of COOPS) {
    const coopId = ids.next();
    coopParties[coop.key] = coopId;
    push(
      envelope(
        { id: coopId, type: 'party', occurredAt: at(0), assertedBy: coopId },
        {
          kind: 'cooperative',
          display_name: coop.name,
          identifiers: [],
          contacts: [{ channel: 'phone', value: `+2567770000${coop.key.charCodeAt(0) - 64}0` }],
          primary_region: { code: coop.district.code, vintage: coop.district.vintage },
        },
      ),
      'contract_performance',
    );
  }

  push(
    envelope({ id: lender, type: 'party', occurredAt: at(0), assertedBy: lender }, {
      kind: 'institution',
      display_name: 'Rift Valley Agricultural Finance',
      identifiers: [],
      contacts: [{ channel: 'phone', value: '+256770000099' }],
      primary_region: { code: 'UG.KAMPALA', vintage: '2020' },
    }),
    'contract_performance',
  );

  for (const coop of COOPS) {
    const coopId = coopParties[coop.key];

    const officerId = ids.next();
    officers[coop.key] = officerId;
    push(
      envelope({ id: officerId, type: 'party', occurredAt: at(1), assertedBy: coopId }, {
        kind: 'person',
        display_name: `Officer ${coop.key}-01`,
        identifiers: [],
        contacts: [{ channel: 'phone', value: `+2567781000${coop.key.charCodeAt(0) - 64}1` }],
        primary_region: { code: coop.district.code, vintage: coop.district.vintage },
      }),
      'contract_performance',
    );

    const buyerId = ids.next();
    buyers[coop.key] = buyerId;
    push(
      envelope({ id: buyerId, type: 'party', occurredAt: at(1), assertedBy: coopId }, {
        kind: 'business',
        display_name: `${coop.district.code.split('.')[1]} Grain Traders Ltd`,
        identifiers: [],
        contacts: [{ channel: 'phone', value: `+2567782000${coop.key.charCodeAt(0) - 64}2` }],
        primary_region: { code: coop.district.code, vintage: coop.district.vintage },
      }),
      'contract_performance',
    );

    const transporterId = ids.next();
    transporters[coop.key] = transporterId;
    push(
      envelope({ id: transporterId, type: 'party', occurredAt: at(1), assertedBy: coopId }, {
        kind: 'business',
        display_name: `${coop.district.code.split('.')[1]} Haulage`,
        identifiers: [],
        contacts: [{ channel: 'phone', value: `+2567783000${coop.key.charCodeAt(0) - 64}3` }],
        primary_region: { code: coop.district.code, vintage: coop.district.vintage },
      }),
      'contract_performance',
    );

    const facilityId = ids.next();
    facilities[coop.key] = facilityId;
    const centroid = CENTROIDS[coop.key];
    push(
      envelope({ id: facilityId, type: 'facility', occurredAt: at(2), assertedBy: coopId }, {
        kind: 'collection_point',
        operated_by: coopId,
        location: geoPoint(rng, centroid.lat, centroid.lon, at(2, 8)),
        admin_region: { code: coop.district.code, vintage: coop.district.vintage },
      }),
      'contract_performance',
    );
  }

  /* Farmers, memberships, plots, plantings. Twenty per coop. */

  const plots: Record<string, string> = {};
  const harvests: Record<string, { id: string; claimedKg: number; actualKg: number }> = {};

  for (const coop of COOPS) {
    const coopId = coopParties[coop.key];
    const centroid = CENTROIDS[coop.key];

    for (let i = 0; i < 20; i += 1) {
      const given = GIVEN_NAMES[(i * 7 + coop.key.charCodeAt(0)) % GIVEN_NAMES.length]!;
      const family = FAMILY_NAMES[(i * 11 + coop.key.charCodeAt(0)) % FAMILY_NAMES.length]!;
      const name = `${given} ${family}`;
      const farmerId = ids.next();
      // Roughly two thirds hold a national ID. The rest are exactly the people
      // a credit system tends to quietly exclude, so they belong in the corpus.
      const hasNin = rng.chance(0.65);

      push(
        envelope({ id: farmerId, type: 'party', occurredAt: at(3), assertedBy: coopId }, {
          kind: 'person',
          display_name: name,
          identifiers: hasNin
            ? [
                {
                  scheme: 'ug.nira.nin',
                  value: `CM${rng.int(10000000, 99999999)}${coop.key}${i}`,
                  attested_by: coopId,
                  attested_at: at(3, 10),
                },
              ]
            : [],
          contacts: [{ channel: 'phone', value: `+25677${rng.int(1000000, 9999999)}` }],
          primary_region: { code: coop.district.code, vintage: coop.district.vintage },
        }),
        'contract_performance',
      );
      farmers.push({ id: farmerId, name, coop: coop.key, hasNin });

      push(
        envelope({ id: ids.next(), type: 'membership', occurredAt: at(4), assertedBy: coopId }, {
          member: farmerId,
          organisation: coopId,
          role: 'member',
          joined_at: '2024-03-01',
        }),
        'contract_performance',
      );

      const plotId = ids.next();
      plots[farmerId] = plotId;
      // Invented. The plot-area distribution is UNPS's to supply and UNPS is
      // behind a login — see `docs/data-sources.md`.
      const plotAcres = round(rng.normalWithin(1.2, 0.6, 0.2, 4), 2);
      push(
        envelope({ id: plotId, type: 'plot', occurredAt: at(5), assertedBy: coopId }, {
          held_by: farmerId,
          tenure: rng.pick(['owned', 'customary', 'rented'] as const),
          centroid: geoPoint(rng, centroid.lat, centroid.lon, at(5, 11)),
          area: {
            value: plotAcres,
            unit: 'acre',
            method: 'declared',
          },
          admin_region: { code: coop.district.code, vintage: coop.district.vintage },
          local_name: `${family} home garden`,
        }),
        'contract_performance',
      );

      const plantedAcres = round(
        Math.min(plotAcres, rng.normalWithin(1, 0.5, 0.2, 3.5)),
        2,
      );
      push(
        envelope({ id: ids.next(), type: 'planting', occurredAt: at(DAY.planting), assertedBy: coopId }, {
          plot: plotId,
          crop: coop.commodity,
          variety: rng.pick(VARIETIES),
          season: SEASON,
          area_planted: {
            value: plantedAcres,
            unit: 'acre',
            method: 'declared',
          },
        }),
        'contract_performance',
      );

      // The harvest is what the farmer took off the plot. Lots are composed of
      // harvests, so this is the input side of every later mass balance.
      //
      // Work order M2: the size comes from the area planted and the FAOSTAT
      // national yield, not from a number somebody picked. The spread around
      // the national mean is still invented — FAOSTAT publishes a mean.
      const harvestBags = harvestBagsFor(coop, plantedAcres, rng, profile);
      const harvestId = ids.next();
      harvests[farmerId] = {
        id: harvestId,
        // What the coop's app *says* it weighs, at the coop's own factor.
        claimedKg: harvestBags * coop.factor,
        // What it actually weighs, at the container's true capacity.
        actualKg: harvestBags * coop.bagMean,
      };
      push(
        envelope({ id: harvestId, type: 'harvest', occurredAt: at(DAY.harvest), assertedBy: coopId }, {
          plot: plotId,
          crop: coop.commodity,
          quantity: quantityFor(coop, harvestBags, 'field_estimated'),
        }),
        'contract_performance',
      );
    }
  }

  /* Delegations. One officer per coop may record on behalf of members. */

  const delegations = {} as Record<CoopFixture['key'], string>;
  const bylawDelegation = { key: 'B' as const, id: '' };

  for (const coop of COOPS) {
    const coopId = coopParties[coop.key];
    const officerId = officers[coop.key];
    const members = farmers.filter((f) => f.coop === coop.key);
    // Coop B's officer holds a bylaw delegation over forty farmers — twenty of
    // its own and twenty of coop A's, because the two share a catchment. A
    // bylaw is the weakest ground in the enum and this is what it looks like
    // when it is used at scale.
    const isBylaw = coop.key === 'B';
    const delegationId = ids.next();
    delegations[coop.key] = delegationId;
    if (isBylaw) bylawDelegation.id = delegationId;

    push(
      envelope({ id: delegationId, type: 'delegation', occurredAt: at(6), assertedBy: coopId }, {
        delegator: coopId,
        delegate: officerId,
        scope: ['delivery', 'harvest', 'observation'],
        granted_at: at(6, 9),
        granted_via: isBylaw ? 'organisational_bylaw' : 'in_person_signature',
        expires_at: null,
      }),
      'contract_performance',
    );
    void members;
  }

  /* Agreements. One forward per coop, plus a second for the over-delivery case. */

  const agreements = {} as Record<CoopFixture['key'], string>;
  let overDeliveredAgreement = '';

  for (const coop of COOPS) {
    const coopId = coopParties[coop.key];
    const agreementId = ids.next();
    agreements[coop.key] = agreementId;
    push(
      envelope({ id: agreementId, type: 'agreement', occurredAt: at(DAY.agreement), assertedBy: coopId }, {
        kind: 'forward',
        parties: [
          { party: coopId, role: 'supplier' },
          { party: buyers[coop.key], role: 'buyer' },
        ],
        commodity: coop.commodity,
        quantity_committed: {
          raw_value: 40,
          raw_unit: 'tonne',
          raw_unit_label: null,
          normalized_kg: 40000,
          conversion_id: CONVERSIONS.tonne,
          measurement_method: 'coop_counted',
        },
        price_terms: {
          basis: 'fixed',
          value: { amount_minor: 1150, currency: 'UGX' },
          index_ref: null,
        },
        delivery_window: { from: at(DAY.deliveryFirst, 0), to: at(DAY.deliveryFirst + DAY.deliverySpan, 23) },
        season: SEASON,
        agreed_at: at(DAY.agreement, 14),
      }),
      'contract_performance',
    );
  }

  // Coop A signs a second, small forward that its deliveries will overshoot.
  overDeliveredAgreement = ids.next();
  push(
    envelope(
      {
        id: overDeliveredAgreement,
        type: 'agreement',
        occurredAt: at(DAY.agreement + 1),
        assertedBy: coopParties.A,
      },
      {
        kind: 'forward',
        parties: [
          { party: coopParties.A, role: 'supplier' },
          { party: buyers.A, role: 'buyer' },
        ],
        commodity: COOPS[0]!.commodity,
        quantity_committed: {
          raw_value: 2,
          raw_unit: 'tonne',
          raw_unit_label: null,
          normalized_kg: 2000,
          conversion_id: CONVERSIONS.tonne,
          measurement_method: 'coop_counted',
        },
        price_terms: {
          basis: 'fixed',
          value: { amount_minor: 1200, currency: 'UGX' },
          index_ref: null,
        },
        delivery_window: { from: at(DAY.deliveryFirst, 0), to: at(DAY.deliveryFirst + DAY.deliverySpan, 23) },
        season: SEASON,
        agreed_at: at(DAY.agreement + 1, 14),
      },
    ),
    'contract_performance',
  );

  /* Deliveries. Roughly 200, two or three per farmer. */

  const deliveries: DeliveryRecord[] = [];
  let futureDated = 0;

  const deliveryDay = (index: number) =>
    DAY.deliveryFirst + (index % DAY.deliverySpan);

  for (const coop of COOPS) {
    const coopId = coopParties[coop.key];
    const members = farmers.filter((f) => f.coop === coop.key);

    members.forEach((farmer, index) => {
      // Invented: no source obtained for how often a member delivers, or how
      // much at a time. See `docs/data-sources.md`.
      const count = rng.int(2, 3);
      for (let d = 0; d < count; d += 1) {
        const day = deliveryDay(index * 3 + d);
        const bags = rng.int(3, 14);
        const confirmed = rng.chance(coop.confirmationRate);
        const deliveryId = ids.next();
        // Coop C sends every third load over the buyer's scale. Those are the
        // ones where the wrong factor becomes visible in a single record.
        const weighed = coop.key === 'C' && (index * 3 + d) % 3 === 0;

        // Clock skew. Handsets in the field are not synchronised, and a record
        // is not wrong because its timestamp is: 5% land a few days off, and 1%
        // land after the server received them, which must be flagged and kept.
        const broken = rng.chance(0.01);
        const skewed = !broken && rng.chance(0.05);
        const occurredAt = broken
          ? at(DAY.brokenClock, rng.int(7, 17))
          : at(day + (skewed ? -rng.int(1, 7) : 0), rng.int(7, 17));
        if (broken) futureDated += 1;

        push(
          envelope(
            {
              id: deliveryId,
              type: 'delivery',
              occurredAt,
              assertedBy: coopId,
            },
            {
              from_party: farmer.id,
              to_party: coopId,
              lot: null,
              fulfils: agreements[coop.key],
              commodity: coop.commodity,
              quantity: weighed
                ? weighedAgainstTheWrongFactor(coop, bags)
                : quantityFor(coop, bags),
              location: facilities[coop.key],
              agreed_price: { amount_minor: 1150, currency: 'UGX' },
              counterparty_confirmed_at: confirmed ? at(day, 18) : null,
              counterparty_confirmed_by: confirmed ? farmer.id : null,
            },
          ),
          // A priced delivery carries financial data about an identifiable
          // person. s.9(1) prohibits that outright; s.9(3)(b) consent is the
          // only ground the kernel exposes. See the finding in 0023.
          'special_data_consent',
        );

        deliveries.push({
          id: deliveryId,
          farmer: farmer.id,
          coop: coop.key,
          normalizedKg: weighed ? bags * coop.bagMean : bags * coop.factor,
          day,
        });
      }
    });
  }

  // A 1% chance over ~200 draws can come up empty. The corpus is a fixture, not
  // a simulation: if the seed produced no future-dated delivery, force one.
  if (futureDated === 0) {
    const victim = deliveries[0]!;
    const coop = COOPS.find((c) => c.key === victim.coop)!;
    push(
      envelope(
        {
          id: ids.next(),
          type: 'delivery',
          occurredAt: at(DAY.brokenClock, 11),
          assertedBy: coopParties[victim.coop],
        },
        {
          from_party: victim.farmer,
          to_party: coopParties[victim.coop],
          lot: null,
          fulfils: agreements[victim.coop],
          commodity: coop.commodity,
          quantity: quantityFor(coop, 4),
          location: facilities[victim.coop],
          agreed_price: { amount_minor: 1150, currency: 'UGX' },
          counterparty_confirmed_at: null,
          counterparty_confirmed_by: null,
        },
      ),
      'special_data_consent',
    );
  }

  /* Lots, custody, and the mass balance. */

  const lots: LotRecord[] = [];

  for (const coop of COOPS) {
    const coopId = coopParties[coop.key];
    const members = farmers.filter((f) => f.coop === coop.key);

    for (let half = 0; half < 2; half += 1) {
      const group = members.slice(half * 10, half * 10 + 10);
      const components = group.map((farmer) => ({
        source_ref: harvests[farmer.id]!.id,
        source_type: 'harvest',
        quantity: {
          raw_value: round(harvests[farmer.id]!.claimedKg, 3),
          raw_unit: 'kg',
          raw_unit_label: null,
          normalized_kg: round(harvests[farmer.id]!.claimedKg, 3),
          conversion_id: null,
          measurement_method: 'coop_counted',
        },
        basis: 'physical',
      }));
      const claimed = group.reduce((sum, f) => sum + harvests[f.id]!.claimedKg, 0);
      const actual = group.reduce((sum, f) => sum + harvests[f.id]!.actualKg, 0);

      // What the weighbridge says when the lot is made up. For coop C that is
      // the real weight of 118kg bags its app has been calling 100kg — the
      // whole corpus exists to make that difference visible.
      const weighed =
        coop.key === 'C'
          ? actual
          : coop.key === 'A'
            ? claimed * 0.995
            : coop.key === 'B'
              ? claimed * 0.97
              : claimed;

      const lotId = ids.next();
      lots.push({ id: lotId, coop: coop.key, openingKg: round(weighed, 3) });
      push(
        envelope({ id: lotId, type: 'lot', occurredAt: at(DAY.lot), assertedBy: coopId }, {
          commodity: coop.commodity,
          quantity: kg(round(weighed, 3)),
          custodian: coopId,
          location: facilities[coop.key],
          composed_of: components,
          grade: null,
        }),
        'contract_performance',
      );
    }
  }

  for (const lot of lots) {
    const coop = COOPS.find((c) => c.key === lot.coop)!;
    const coopId = coopParties[lot.coop];
    const drift = () =>
      coop.balanceRandom
        ? rng.normalWithin(0, coop.balanceDrift, -coop.balanceDrift, coop.balanceDrift)
        : coop.balanceDrift;

    const outKg = round(lot.openingKg * (1 + drift()), 3);
    push(
      envelope(
        { id: ids.next(), type: 'custody_transfer', occurredAt: at(DAY.transferOut), assertedBy: coopId },
        {
          lot: lot.id,
          from_party: coopId,
          to_party: transporters[lot.coop],
          location: facilities[lot.coop],
          quantity: kg(outKg),
        },
      ),
      'contract_performance',
    );

    // Coop B declares part of its shrinkage. A declared loss is not a failure,
    // it is the difference between shrinkage and unexplained shrinkage.
    if (lot.coop === 'B') {
      push(
        envelope(
          { id: ids.next(), type: 'observation', occurredAt: at(DAY.loss), assertedBy: coopId },
          {
            subject_type: 'lot',
            subject_ref: lot.id,
            observation_type: 'loss.declared',
            value: { kind: 'quantity', value: kg(round(outKg * 0.01, 3)) },
            method: 'reported',
            instrument: null,
          },
        ),
        'consent',
      );
    }

    const inKg = round(outKg * (1 + drift()), 3);
    push(
      envelope(
        { id: ids.next(), type: 'custody_transfer', occurredAt: at(DAY.transferIn), assertedBy: coopId },
        {
          lot: lot.id,
          from_party: transporters[lot.coop],
          to_party: buyers[lot.coop],
          location: facilities[lot.coop],
          quantity: kg(inKg),
        },
      ),
      'contract_performance',
    );
  }

  /* Obligations and settlements. */

  const obligations = {} as Record<CoopFixture['key'], string>;
  for (const coop of COOPS) {
    const coopId = coopParties[coop.key];
    const obligationId = ids.next();
    obligations[coop.key] = obligationId;
    const amount = 8_400_000 + coop.key.charCodeAt(0) * 1000;

    push(
      envelope(
        { id: obligationId, type: 'obligation', occurredAt: at(DAY.obligation), assertedBy: coopId },
        {
          kind: 'payment_for_goods',
          obligor: buyers[coop.key],
          obligee: coopId,
          amount: { amount_minor: amount, currency: 'UGX' },
          due_at: at(DAY.settlement, 17),
          arising_from: agreements[coop.key],
        },
      ),
      'special_data_consent',
    );

    // A: paid. B: part-paid, and the gap is the point. C: nothing at all.
    // D: paid. An obligation with no settlement is not an error state.
    const paid = coop.key === 'A' || coop.key === 'D' ? amount : coop.key === 'B' ? Math.round(amount * 0.6) : 0;
    if (paid > 0) {
      push(
        envelope(
          {
            id: ids.next(),
            type: 'settlement_reference',
            occurredAt: at(DAY.settlement),
            assertedBy: coopId,
          },
          {
            obligation: obligationId,
            amount: { amount_minor: paid, currency: 'UGX' },
            settled_at: at(DAY.settlement, 12),
            rail: 'mtn_momo',
            external_ref: `MP${coop.key}${paid}`,
            confirmed_by: coopId,
          },
        ),
        'special_data_consent',
      );
    }
  }

  /* Moisture readings. Non-financial, and recorded under consent so that J2 has
     a basis an objection actually stops. */

  for (const coop of COOPS) {
    const coopId = coopParties[coop.key];
    push(
      envelope(
        { id: ids.next(), type: 'observation', occurredAt: at(DAY.lot, 10), assertedBy: coopId },
        {
          subject_type: 'facility',
          subject_ref: facilities[coop.key],
          observation_type: 'moisture.grain_pct',
          value: { kind: 'scalar', value: round(rng.normalWithin(13.5, 1.5, 9, 20), 1), unit: 'percent' },
          method: 'field_instrument',
          instrument: 'Draminski TwistGrain',
        },
      ),
      'consent',
    );
  }

  const lenderFarmerA = farmers.find((f) => f.coop === 'A')!.id;
  const lenderFarmerC = farmers.find((f) => f.coop === 'C')!.id;

  const plan: SeedPlan = {
    seed,
    profile,
    writes,
    farmers,
    coopParties,
    lender,
    grants: lenderGrants(lender, lenderFarmerA, lenderFarmerC, coopParties),
    markers: {
      supersededDelivery: '',
      supersedingDelivery: '',
      forkParent: '',
      forkLeft: '',
      forkRight: '',
      retractedDelivery: '',
      retraction: '',
      scopeMismatchDelivery: '',
      regionUnresolvableDelivery: '',
      unresolvedDeliveries: deliveries.filter((d) => d.coop === 'D').map((d) => d.id),
      partiallyFulfilledAgreement: agreements.C,
      forkAgreement: agreements.A,
      overDeliveredAgreement,
      partiallySettledObligation: obligations.B,
      unsettledObligation: obligations.C,
      inference: '',
      lenderFarmerA,
      lenderFarmerC,
    },
  };

  appendAdversarial(plan, {
    rng,
    ids,
    push,
    coopParties,
    officers,
    facilities,
    plots,
    delegations,
    bylawDelegationId: bylawDelegation.id,
    overDeliveredAgreement,
    agreements,
    obligations,
    farmers,
    deliveries,
    lots,
    lender,
  });

  return plan;
}

/** The twelve weights are reduced to summary statistics by migration 0014. */
export const coopASampleStats = () => {
  const n = COOP_A_SAMPLE.length;
  const mean = COOP_A_SAMPLE.reduce((a, b) => a + b, 0) / n;
  const variance = COOP_A_SAMPLE.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return {
    size: n,
    min: Math.min(...COOP_A_SAMPLE),
    max: Math.max(...COOP_A_SAMPLE),
    stddev: Math.sqrt(variance),
  };
};
