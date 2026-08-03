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

/** The twelve kaveera behind the `measured` factor in migration 0014. */
export const COOP_A_SAMPLE = [
  97.4, 101.2, 99.8, 103.6, 96.9, 100.4, 98.2, 102.7, 99.1, 104.3, 95.8, 100.6,
] as const;

/** Conversions the seed cites. Ids are registry rows, not records. */
export const CONVERSIONS = {
  /** Migration 0014. Weighed, twelve bags, coop A. */
  maizeBagMeasured: '019fc600-0000-7000-8000-000000000050',
  /** Migration 0010. The commonly quoted 100 kg bag, unverified. */
  maizeBagAssumed: '019fc600-0000-7000-8000-000000000020',
  /** Migration 0010. Region-scoped to Kapchorwa, which no delivery can claim. */
  maizeBagKapchorwa: '019fc600-0000-7000-8000-000000000030',
  /** Migration 0010. SI, for agreements committed in tonnes. */
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
  'occurred_after_recorded',
  'mass_balance_discrepancy',
  'delegated_authority',
  'delegated_by_organisational_bylaw',
  'quantity_not_normalized',
] as const;
