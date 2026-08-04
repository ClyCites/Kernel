import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Pool } from 'pg';

/**
 * The pool the training path reads through. Connected as `kernel_training`
 * (migration 0028), which holds SELECT on `facts.record` and nothing else.
 *
 * A distinct token rather than a distinct query, because the requirement is
 * that training *cannot* reach a prediction. Sharing `KERNEL_POOL` and adding
 * `where record_class = 'observation'` would put the invariant in the hands of
 * whoever writes the next query, and a filter that can be forgotten will be.
 */
export const TRAINING_POOL = Symbol('TRAINING_POOL');

/** A row as the training path sees it. Deliberately not `StoredRecord`. */
export interface TrainingRow {
  id: string;
  type: string;
  occurred_at: string;
  recorded_at: string;
  subject: string | null;
  body: Record<string, unknown>;
  quality_flags: string[];
}

export class TrainingUnavailable extends Error {
  constructor() {
    super('no training connection is configured on this instance');
    this.name = 'TrainingUnavailable';
  }
}

export interface TrainingQuery {
  type?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
}

export const TRAINING_MAX_LIMIT = 1000;

/**
 * Spec §6, and the reason the two record classes are in separate schemas.
 *
 * Every query in this file names `facts.record` and no other relation. That is
 * not a convention: as `kernel_training` there is no other relation to name.
 * `inference.record` fails with permission denied on the schema, and
 * `kernel.record_key` too — the key table spans both namespaces and would
 * enumerate every prediction in the system by id.
 *
 * `dataset` is pinned to 'live' for a second reason, which is that training on
 * fabricated seed records is the same failure by a different route.
 */
@Injectable()
export class TrainingRepository {
  constructor(
    @Optional() @Inject(TRAINING_POOL) private readonly pool: Pool | null = null,
  ) {}

  get configured(): boolean {
    return this.pool !== null;
  }

  async observations(query: TrainingQuery = {}): Promise<TrainingRow[]> {
    const pool = this.pool;
    if (pool === null) throw new TrainingUnavailable();

    const limit = Math.min(query.limit ?? 100, TRAINING_MAX_LIMIT);
    const { rows } = await pool.query<TrainingRow>(
      `select id, type,
              to_json(occurred_at) #>> '{}' as occurred_at,
              to_json(recorded_at) #>> '{}' as recorded_at,
              body ->> 'subject_ref' as subject,
              body, quality_flags
         from facts.record
        where dataset = 'live'
          and ($1::text is null or type = $1)
          and ($2::timestamptz is null or recorded_at >= $2)
          and ($3::timestamptz is null or recorded_at < $3)
        order by recorded_at, id
        limit $4`,
      [query.type ?? null, query.since ?? null, query.until ?? null, limit],
    );
    return rows;
  }
}
