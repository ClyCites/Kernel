import type { ConversionBasis } from '@clycites/schema';

/**
 * The four cooperatives, and what is wrong with each. Work order D3.
 *
 * The point of the corpus is not that it looks like production data. It is that
 * a well-run cooperative and a badly-run one are distinguishable *from the
 * records alone*, without anyone being told which is which — and that the
 * failure modes are the ones the field will actually produce.
 */

export const SEASON = '2026A';

/** Hectares in an acre. Plots are declared in acres; yields are published in hectares. */
export const ACRE_IN_HA = 0.404686;

/**
 * Which yield figures a run was built from. Work order P1.
 *
 * `faostat` is the real thing and gives the corpus its realism. FAO's terms
 * for FAOSTAT permit reuse under CC BY 4.0 but bar use "in connection with
 * promoting a commercial enterprise" — and the lender view is precisely that,
 * a document put in front of a financier to show what the product can do.
 * Attribution does not cure that; the restriction is on the purpose.
 *
 * So `demo` exists: a second table, invented outright, for anything shown
 * outside. It is deliberately not a rounding of the FAOSTAT numbers, because
 * a rounding is still derived from them. It is in the right order of
 * magnitude and nothing more.
 *
 * Every artifact prints which profile produced it. A reader who cannot tell
 * whether a number came from FAO or from us has been misled either way round.
 */
export type YieldProfile = 'faostat' | 'demo';

/**
 * Yield in kg per hectare, per harvest. Work order M2.
 *
 * FAOSTAT QCL, Uganda, 2024, element `Yield`. Retrieved 2026-08-03 from the
 * bulk download; CC BY 4.0. See `docs/data-sources.md` for the citation, and
 * for why `Production ÷ Area harvested` is read as a *per-harvest* figure
 * rather than an annual one — if that reading is wrong every harvest in the
 * corpus is out by about a factor of two.
 *
 * A national mean, so it carries no district variation. The spread applied
 * around it below is invented, because FAOSTAT publishes a mean and not a
 * distribution.
 *
 * Internal use only. See `YieldProfile`.
 */
export const NATIONAL_YIELD_KG_PER_HA: Record<string, number> = {
  'crop.maize.grain': 2173.9,
  'crop.beans.dry': 918.8,
};

/**
 * Invented. Not FAO data, not derived from FAO data, not to be cited as
 * either. Plausible round numbers for a crop in this region, chosen so that
 * the demo corpus is the right shape without borrowing anyone's figures.
 */
export const DEMO_YIELD_KG_PER_HA: Record<string, number> = {
  'crop.maize.grain': 1800,
  'crop.beans.dry': 750,
};

/**
 * Smallholder haircut. An assumption, not a source.
 *
 * A FAOSTAT national yield is total production over total area harvested, and
 * that denominator includes commercial estates with irrigation, certified
 * seed and mechanised handling. Every farmer in this corpus holds between one
 * and four acres. Applying the national mean to them overstates what they
 * grow, and every derived figure downstream — mass balance, delivery volume,
 * what a lender would see as capacity — inherits the overstatement.
 *
 * 0.72 is a judgement, sitting inside the range smallholder studies for the
 * region tend to report, and it is recorded in `docs/data-sources.md` under
 * assumptions rather than sources because no single publication supports it.
 * It applies to both profiles: the demo numbers are invented, but they are
 * invented as national figures and the same reasoning applies to them.
 */
export const SMALLHOLDER_YIELD_HAIRCUT = 0.72;

/** The table a run should use, already haircut. */
export const yieldFor = (profile: YieldProfile, commodity: string): number | undefined => {
  const table = profile === 'faostat' ? NATIONAL_YIELD_KG_PER_HA : DEMO_YIELD_KG_PER_HA;
  const national = table[commodity];
  return national === undefined ? undefined : national * SMALLHOLDER_YIELD_HAIRCUT;
};

/** Invented. The variation a national mean does not carry. */
export const HARVEST_YIELD_SPREAD = {
  stddev: 0.35,
  min: 0.3,
  max: 2.0,
} as const;

/** The twelve kaveera behind the `measured` factor in migration 0015. */
export const COOP_A_SAMPLE = [
  97.4, 101.2, 99.8, 103.6, 96.9, 100.4, 98.2, 102.7, 99.1, 104.3, 95.8, 100.6,
] as const;

/** Conversions the seed cites. Ids are registry rows, not records. */
export const CONVERSIONS = {
  /** Migration 0015. Weighed, twelve bags, coop A, with the weights on file. */
  maizeBagMeasured: '019fc600-0000-7000-8000-000000000051',
  /** Migration 0010. The commonly quoted 100 kg bag, unverified. */
  maizeBagAssumed: '019fc600-0000-7000-8000-000000000020',
  /** Migration 0010. Region-scoped to Kapchorwa, which no delivery can claim. */
  maizeBagKapchorwa: '019fc600-0000-7000-8000-000000000030',  /** Migration 0010. SI, for agreements committed in tonnes. */
  tonne: '019fc600-0000-7000-8000-000000000002',
} as const;

export interface CoopFixture {
  key: 'A' | 'B' | 'C' | 'D';
  name: string;
  /** UG admin code and vintage. One district each, so districts are separable. */
  district: { code: string; vintage: string };
  commodity: string;
  rawUnit: string;
  rawUnitLabel: string | null;
  /** What a container here actually holds, and how consistently. */
  bagMean: number;
  bagStddev: number;
  /** The factor the coop's app applies, and the registry row it cites. */
  conversionId: string | null;
  factor: number;
  conversionBasis: ConversionBasis | null;
  /** Share of deliveries the counterparty confirms. */
  confirmationRate: number;
  /** Systematic mass-balance drift per custody leg, as a fraction. */
  balanceDrift: number;
  /** When true, the drift is random noise of `balanceDrift` either way. */
  balanceRandom: boolean;
}

/**
 * D4. Coop C is the interesting one: its bags really do hold 118 kg, and its
 * app converts at 100. Every record it writes is internally consistent and
 * every one of them understates. That is the shape of the error the kernel is
 * for, and it is invisible without a registry.
 */
export const COOPS: readonly CoopFixture[] = [
  {
    key: 'A',
    name: 'Bukoto Farmers Cooperative Society',
    district: { code: 'UG.MASAKA', vintage: '2020' },
    commodity: 'crop.maize.grain',
    rawUnit: 'bag',
    rawUnitLabel: 'kaveera',
    bagMean: 100,
    bagStddev: 3,
    conversionId: CONVERSIONS.maizeBagMeasured,
    factor: 100,
    conversionBasis: 'measured',
    confirmationRate: 0.9,
    balanceDrift: -0.005,
    balanceRandom: false,
  },
  {
    key: 'B',
    name: 'Kiryandongo Grain Growers',
    district: { code: 'UG.KIRYANDONGO', vintage: '2020' },
    commodity: 'crop.maize.grain',
    rawUnit: 'bag',
    rawUnitLabel: 'kaveera',
    bagMean: 100,
    bagStddev: 12,
    conversionId: CONVERSIONS.maizeBagAssumed,
    factor: 100,
    conversionBasis: 'assumed_default',
    confirmationRate: 0.3,
    balanceDrift: -0.03,
    balanceRandom: false,
  },
  {
    key: 'C',
    name: 'Kapchorwa Highland Producers',
    district: { code: 'UG.KAPCHORWA', vintage: '2020' },
    commodity: 'crop.maize.grain',
    rawUnit: 'bag',
    rawUnitLabel: 'gunia',
    bagMean: 118,
    bagStddev: 5,
    conversionId: CONVERSIONS.maizeBagAssumed,
    factor: 100,
    conversionBasis: 'assumed_default',
    confirmationRate: 0.65,
    balanceDrift: 0.08,
    balanceRandom: true,
  },
  {
    key: 'D',
    name: 'Nebbi Bean Growers Association',
    district: { code: 'UG.NEBBI', vintage: '2020' },
    commodity: 'crop.beans.dry',
    rawUnit: 'basket',
    rawUnitLabel: 'kikapu',
    bagMean: 32,
    bagStddev: 2,
    // No registry row covers a basket of beans. The coop's app cites one anyway,
    // which is what an app does when nobody has told it the factor is a fiction.
    conversionId: null,
    factor: 32,
    conversionBasis: null,
    confirmationRate: 0.5,
    balanceDrift: 0,
    balanceRandom: false,
  },
];

/**
 * Names. Two of these repeat inside a coop and two more repeat across coops
 * with different spellings — see `adversarial.ts`. Everything else is filler,
 * and filler that looks like a real register matters: a seed full of
 * `Farmer 17` cannot demonstrate that identity resolution is hard.
 */
export const GIVEN_NAMES = [
  'Nakato', 'Wasswa', 'Nabirye', 'Okello', 'Achieng', 'Mugisha', 'Aketch',
  'Byaruhanga', 'Nalwoga', 'Opio', 'Kirabo', 'Amoding', 'Sekandi', 'Atim',
  'Namugga', 'Ochieng', 'Kyomuhendo', 'Wanyama', 'Nassuna', 'Ekwaru',
] as const;

export const FAMILY_NAMES = [
  'Ssemakula', 'Okurut', 'Nabbanja', 'Tumusiime', 'Odongo', 'Kaggwa',
  'Aturinde', 'Lubega', 'Ayebazibwe', 'Ojok', 'Nsubuga', 'Chelangat',
  'Mukisa', 'Adong', 'Katusiime', 'Waiswa', 'Nakimuli', 'Obua', 'Birungi',
  'Etyang',
] as const;

export const VARIETIES = ['Longe 10H', 'Longe 5', 'Bazooka', 'NABE 15'] as const;

/**
 * D6 expects these to appear. Named here rather than as string literals in the
 * assertions so a rename in the kernel breaks the seed loudly.
 */
export const EXPECTED_FLAGS = [
  'conversion_mismatch',
  'conversion_unresolved',
  'conversion_scope_mismatch',
  // Added by P1, when the region comparison was split. It says the check
  // could not run, not that the record is wrong, and it exists so that
  // `conversion_scope_mismatch` can be trusted to mean the latter.
  'region_unresolvable',
  'occurred_after_recorded',
  'mass_balance_discrepancy',
  'delegated_authority',
  'delegated_by_organisational_bylaw',
  'quantity_not_normalized',
  // The loudest flag in the corpus by an order of magnitude, and the trust
  // ladder firing. It went unasserted for a version, which is precisely the
  // drift D6 exists to catch.
  'measurement_below_underwritable',
] as const;
