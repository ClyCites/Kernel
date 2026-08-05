import {
  LawfulBasis as LawfulBasisEnum,
  objectionStops as schemaObjectionStops,
} from '@clycites/schema';

import type { RecordDocument } from './record.js';

/**
 * The grounds the Data Protection and Privacy Act, 2019 allows personal data to
 * be processed on.
 *
 * The list itself moved to @clycites/schema in v0.3 and is re-exported here so
 * the kernel's call sites keep their existing import. It belongs in the schema
 * because `lawful_basis` is now an envelope field: every application that
 * writes a record supplies one, so the set of legal values is part of the
 * contract rather than an internal kernel detail.
 *
 * The reasoning about what is *not* in the list — there is no member-body
 * ground, because that is an access class resolved per request and a basis
 * mirroring it would let a record assert its own classification — now lives
 * beside the enum. See 0029.
 */
export const LAWFUL_BASES = LawfulBasisEnum.options;

export type LawfulBasis = LawfulBasisEnum;

/**
 * Whether an objection under s.7(3) stops processing of a record held on this
 * basis. Consent given can be withdrawn; a s.7(2) ground is not the subject's
 * to withdraw.
 */
export function objectionStops(basis: LawfulBasis): boolean {
  return schemaObjectionStops(basis);
}

export function isLawfulBasis(value: unknown): value is LawfulBasis {
  return LawfulBasisEnum.safeParse(value).success;
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
