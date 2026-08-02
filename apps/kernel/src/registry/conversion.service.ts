import { Inject, Injectable } from '@nestjs/common';

import { RegistryRepository } from './registry.repository.js';
import type { UnitConversionRow } from './types.js';

/**
 * Conversion checking.
 *
 * The defect this closes: `conversion_id` was accepted as any well-formed UUID.
 * A record could claim `raw_value: 12, raw_unit: "bag", normalized_kg: 5000`
 * and point at a conversion that did not exist — and it would look *more*
 * trustworthy than an unnormalized record, because a downstream reader sees a
 * kilogram figure and stops asking questions.
 *
 * Per invariant P6 none of this rejects. Every finding is a flag.
 */

/** A recomputed weight this far from the client's is treated as agreement. */
const RELATIVE_TOLERANCE = 1e-6;

export const CONVERSION_UNRESOLVED = 'conversion_unresolved';
export const CONVERSION_MISMATCH = 'conversion_mismatch';
export const CONVERSION_SCOPE_MISMATCH = 'conversion_scope_mismatch';

/** What the record itself says the quantity is of, and where it was measured. */
export interface ConversionScope {
  commodity: string | null;
  regionCode: string | null;
  regionVintage: string | null;
  on: string;
}

interface QuantityLike {
  raw_value: number;
  raw_unit: string;
  normalized_kg: number | null;
  conversion_id: string | null;
}

const isQuantity = (value: unknown): value is QuantityLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as QuantityLike).raw_value === 'number' &&
  typeof (value as QuantityLike).raw_unit === 'string';

/** Every quantity in the document, however deeply nested. */
export const quantitiesIn = (
  value: unknown,
  found: QuantityLike[] = [],
): QuantityLike[] => {
  if (Array.isArray(value)) {
    for (const item of value) quantitiesIn(item, found);
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;
  if (isQuantity(value)) found.push(value);
  for (const item of Object.values(value)) quantitiesIn(item, found);
  return found;
};

/**
 * The commodity and boundary a record's quantities should be read against.
 *
 * Only Plot and Facility carry an `admin_region`, and Party a `primary_region`.
 * Most records — a Delivery among them — place themselves nowhere in
 * particular, and a record that never says where it happened cannot support a
 * district-specific factor. That is treated as a mismatch rather than waved
 * through: an unverifiable claim is the thing being flagged.
 */
export const scopeOf = (
  document: Record<string, unknown>,
  occurredAt: string,
): ConversionScope => {
  const commodity =
    typeof document.commodity === 'string'
      ? document.commodity
      : typeof document.crop === 'string'
        ? document.crop
        : null;

  const region = document.admin_region ?? document.primary_region;
  const scoped =
    typeof region === 'object' &&
    region !== null &&
    typeof (region as { code?: unknown }).code === 'string'
      ? (region as { code: string; vintage: string })
      : null;

  return {
    commodity,
    regionCode: scoped?.code ?? null,
    regionVintage: scoped?.vintage ?? null,
    on: occurredAt.slice(0, 10),
  };
};

@Injectable()
export class ConversionService {
  constructor(
    @Inject(RegistryRepository) private readonly registry: RegistryRepository,
  ) {}

  /**
   * Flags raised by the quantities in one document.
   *
   * Async, which is why it runs in the ingest pipeline rather than inside
   * `qualityFlags` — that function stays synchronous and pure, and receives
   * these as input.
   */
  async flags(
    document: Record<string, unknown>,
    occurredAt: string,
  ): Promise<string[]> {
    const quantities = quantitiesIn(document).filter(
      (quantity) => quantity.normalized_kg !== null,
    );
    if (quantities.length === 0) return [];

    const scope = scopeOf(document, occurredAt);
    const ids = quantities
      .map((quantity) => quantity.conversion_id)
      .filter((id): id is string => id !== null);
    const rows = await this.registry.conversions(ids);
    const flags = new Set<string>();

    for (const quantity of quantities) {
      // `conversion_id` can only be null here when `raw_unit` is already kg:
      // the schema's own refinement rejects a normalized weight without a
      // citation for every other unit. Nothing to check.
      if (quantity.conversion_id === null) continue;

      const conversion = rows.get(quantity.conversion_id);
      if (conversion === undefined) {
        flags.add(CONVERSION_UNRESOLVED);
        continue;
      }

      if (!this.applies(conversion, quantity.raw_unit, scope)) {
        flags.add(CONVERSION_SCOPE_MISMATCH);
      }

      // The point of the whole exercise: derive the number ourselves rather
      // than trusting the one we were handed.
      const expected = quantity.raw_value * conversion.factor;
      const claimed = quantity.normalized_kg ?? 0;
      const scale = Math.max(Math.abs(expected), Math.abs(claimed), 1);
      if (Math.abs(expected - claimed) / scale > RELATIVE_TOLERANCE) {
        flags.add(CONVERSION_MISMATCH);
      }
    }

    return [...flags];
  }

  /**
   * Whether a resolvable conversion actually covers this quantity.
   *
   * A conversion with a null commodity or null region is general and applies
   * anywhere. A scoped one applies only within its scope — and a record that
   * does not say where it happened cannot claim a district factor.
   */
  private applies(
    conversion: UnitConversionRow,
    rawUnit: string,
    scope: ConversionScope,
  ): boolean {
    if (conversion.from_unit !== rawUnit) return false;
    if (conversion.to_unit !== 'kg') return false;

    if (
      conversion.commodity !== null &&
      conversion.commodity !== scope.commodity
    ) {
      return false;
    }

    if (conversion.region_code !== null) {
      if (conversion.region_code !== scope.regionCode) return false;
      if (conversion.region_vintage !== scope.regionVintage) return false;
    }

    if (conversion.valid_from !== null && scope.on < conversion.valid_from) {
      return false;
    }
    if (conversion.valid_to !== null && scope.on > conversion.valid_to) {
      return false;
    }

    return true;
  }
}
