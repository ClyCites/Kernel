import type { RecordDocument } from './record.js';

/**
 * The grounds the Data Protection and Privacy Act, 2019 allows personal data to
 * be processed on. Values are s.7(1), the limbs of s.7(2), and s.9(3)(b).
 *
 * Stored per record because s.7(3) turns on it: an objection stops processing
 * "except for data collected or processed under subsection (2)". The answer to
 * "can this farmer make us stop" is fixed at collection and cannot be
 * reconstructed later.
 *
 * There is deliberately no member-body ground here: that is an access class,
 * resolved per request, and a basis mirroring it would let a record assert its
 * own classification. See 0029.
 */
export const LAWFUL_BASES = [
  'consent',
  'legal_authorisation',
  'public_duty',
  'national_security',
  'law_enforcement',
  'contract_performance',
  'medical',
  'legal_obligation',
  'special_data_consent',
] as const;

export type LawfulBasis = (typeof LAWFUL_BASES)[number];

/** The s.7(2) grounds, which s.7(3) exempts from the right to object. */
const SECTION_7_2: ReadonlySet<LawfulBasis> = new Set([
  'legal_authorisation',
  'public_duty',
  'national_security',
  'law_enforcement',
  'contract_performance',
  'medical',
  'legal_obligation',
]);

/**
 * Whether an objection under s.7(3) stops processing of a record held on this
 * basis. Consent given can be withdrawn; a s.7(2) ground is not the subject's
 * to withdraw.
 */
export function objectionStops(basis: LawfulBasis): boolean {
  return !SECTION_7_2.has(basis);
}

export function isLawfulBasis(value: unknown): value is LawfulBasis {
  return LAWFUL_BASES.includes(value as LawfulBasis);
}

/**
 * Record types that carry financial information about an identifiable farmer.
 *
 * s.9(1) lists financial information as special personal data, whose processing
 * is prohibited outside s.9(3). Of those limbs only (b), consent, is reachable
 * for a lending platform, so these types accept nothing else.
 */
const FINANCIAL_TYPES: ReadonlySet<string> = new Set([
  'obligation',
  'settlement_reference',
]);

/**
 * A delivery is ordinarily not special data. One carrying a price is: it states
 * what a named farmer was paid.
 */
export function carriesFinancialData(
  type: string,
  body: RecordDocument,
): boolean {
  if (FINANCIAL_TYPES.has(type)) return true;
  return type === 'delivery' && body['agreed_price'] != null;
}

export interface BasisRejection {
  message: string;
  detail: string;
}

/**
 * Whether this basis may be relied on for this record, or why not.
 *
 * Non-financial types accept any of the nine. Which of the s.7(2) grounds a
 * given record type could honestly rest on is a question for counsel, and
 * guessing at it here would encode an interpretation the work order says to
 * avoid. The one restriction below is required under any reading.
 */
export function checkBasis(
  basis: LawfulBasis,
  type: string,
  body: RecordDocument,
): BasisRejection | null {
  if (!carriesFinancialData(type, body)) return null;
  if (basis === 'special_data_consent') return null;

  return {
    message:
      `a ${type} carries financial information about an identifiable person, ` +
      `which s.9(1) prohibits processing except under s.9(3) — ` +
      `only special_data_consent is available, not ${basis}`,
    detail: 'special data requires consent under s.9(3)(b)',
  };
}
