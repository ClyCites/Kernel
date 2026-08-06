import type { Request } from 'express';

import { DATASETS, type Dataset } from '../records/record.js';
import { isLawfulBasis, type LawfulBasis } from '../records/lawful-basis.js';

/**
 * Which corpus a request means. Brief §D0.
 *
 * The kernel is append-only: there is no DELETE, so a fabricated record written
 * into the live corpus is permanent. It would be counted in metrics, returned
 * to applications as if a farmer had asserted it, and eventually anchored into
 * a published Merkle root — which puts invented farmer records on a public
 * ledger irreversibly. The discriminator keeps the two corpora apart at the
 * row level so that cannot happen by accident.
 *
 * Two things guard the write side and both must hold:
 *
 *  1. `SEED_INGEST_ENABLED` is off by default, so a production instance ignores
 *     this header entirely however the request is dressed up.
 *  2. The header can only ever select `seed`. Nothing can mark a record `live`
 *     that was not already going to be live, and — more importantly — nothing
 *     can mark a real record `seed` to have it skipped by anchoring.
 */
export const DATASET_HEADER = 'x-clycites-dataset';

const FORCED_SEED_DATASET = Symbol('forced-seed-dataset');
type DatasetRequest = Request & { [FORCED_SEED_DATASET]?: true };

/** Set only by the kernel after resolving a registered sandbox OAuth client. */
export function forceSeedDataset(request: Request): void {
  (request as DatasetRequest)[FORCED_SEED_DATASET] = true;
}

export function requestedDataset(
  request: Request,
  seedIngestEnabled: boolean,
): Dataset {
  if ((request as DatasetRequest)[FORCED_SEED_DATASET] === true) return 'seed';
  if (!seedIngestEnabled) return 'live';
  const claim = request.header(DATASET_HEADER);
  return DATASETS.includes(claim as Dataset) ? (claim as Dataset) : 'live';
}

/**
 * The DPPA ground the calling application declares it is collecting under.
 *
 * Unlike the dataset header there is no fallback. An absent or unrecognised
 * value yields `undefined` and ingest rejects the write, because guessing a
 * basis would write an unfounded compliance claim into an append-only log.
 */
export const LAWFUL_BASIS_HEADER = 'x-clycites-lawful-basis';

export function declaredLawfulBasis(request: Request): LawfulBasis | undefined {
  const claim = request.header(LAWFUL_BASIS_HEADER);
  return isLawfulBasis(claim) ? claim : undefined;
}
