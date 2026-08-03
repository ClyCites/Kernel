import { envelopeShape } from '@clycites/schema';

/** The namespaces a record can live in. Spec §6.2 rule 1. */
export type RecordClass = 'observation' | 'inference';

/**
 * Which corpus a row belongs to. Storage-layer plumbing, not an envelope field:
 * @clycites/schema describes what a record asserts about the world, and which
 * corpus a row belongs to is not a claim anybody is making.
 */
export type Dataset = 'live' | 'seed';

export const DATASETS: readonly Dataset[] = ['live', 'seed'];

import type { LawfulBasis } from './lawful-basis.js';
export type { LawfulBasis };

/**
 * A record as it is held in Postgres: envelope in columns, entity body in
 * `jsonb`, kernel-derived flags alongside rather than inside.
 */
export interface StoredRecord {
  id: string;
  type: string;
  record_class: RecordClass;
  schema_version: string;
  occurred_at: string;
  occurred_at_precision: string;
  recorded_at: string;
  asserted_by: string;
  authenticated_as: string | null;
  on_behalf_of: string | null;
  delegation: string | null;
  device_id: string | null;
  supersedes: string | null;
  body: Record<string, unknown>;
  ext: Record<string, unknown>;
  quality_flags: string[];
  dataset: Dataset;
  lawful_basis: LawfulBasis;
}

/**
 * A record in the shape `@clycites/schema` defines — envelope and body flat,
 * `superseded_by` present. This is what crosses the API boundary, and it must
 * round-trip through the entity schema unchanged.
 */
export type RecordDocument = Record<string, unknown>;

/**
 * The envelope field names, taken from the schema package rather than restated.
 * Anything not in this set is entity body.
 */
export const ENVELOPE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(envelopeShape),
);

/** Derived at read time, never stored. See docs/decisions/0002-derived-fields.md. */
export const DERIVED_KEYS: ReadonlySet<string> = new Set(['superseded_by']);

export function splitEnvelope(document: RecordDocument): {
  envelope: RecordDocument;
  body: RecordDocument;
} {
  const envelope: RecordDocument = {};
  const body: RecordDocument = {};

  for (const [key, value] of Object.entries(document)) {
    if (DERIVED_KEYS.has(key)) continue;
    if (ENVELOPE_KEYS.has(key)) envelope[key] = value;
    else body[key] = value;
  }

  return { envelope, body };
}

export interface ToDocumentOptions {
  /** The id of the record that supersedes this one, if any. Derived. */
  supersededBy?: string | null;
}

export function toDocument(
  record: StoredRecord,
  options: ToDocumentOptions = {},
): RecordDocument {
  return {
    id: record.id,
    type: record.type,
    record_class: record.record_class,
    schema_version: record.schema_version,
    occurred_at: record.occurred_at,
    occurred_at_precision: record.occurred_at_precision,
    recorded_at: record.recorded_at,
    asserted_by: record.asserted_by,
    authenticated_as: record.authenticated_as,
    on_behalf_of: record.on_behalf_of,
    delegation: record.delegation,
    device_id: record.device_id,
    supersedes: record.supersedes,
    superseded_by: options.supersededBy ?? null,
    ext: record.ext,
    ...record.body,
  };
}
