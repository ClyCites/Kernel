import type { z } from 'zod';
import { Delegation, Delivery } from '@clycites/schema';

/**
 * The entity schemas the ingest pipeline accepts, keyed by envelope `type`.
 *
 * Every entry points at `@clycites/schema`. Nothing here restates a field, and
 * nothing validates a record a second time (brief §7).
 *
 * Phase 2 registers two:
 *   - `delivery`, the commercially significant entity the write path was built
 *     against;
 *   - `delegation`, because the provenance step cannot be exercised without it —
 *     `on_behalf_of` is checked against a Delegation record in the log.
 *
 * Phase 5 adds the remaining fourteen.
 */
export const ENTITY_SCHEMAS = {
  delivery: Delivery,
  delegation: Delegation,
} as const satisfies Record<string, z.ZodType>;

export type RegisteredEntityType = keyof typeof ENTITY_SCHEMAS;

export function schemaFor(type: string): z.ZodType | null {
  return Object.prototype.hasOwnProperty.call(ENTITY_SCHEMAS, type)
    ? (ENTITY_SCHEMAS[type as RegisteredEntityType] as z.ZodType)
    : null;
}

export function registeredTypes(): string[] {
  return Object.keys(ENTITY_SCHEMAS).sort();
}
