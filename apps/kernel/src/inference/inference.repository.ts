import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import type { Dataset } from '../records/record.js';

export type Verdict = 'confirmed' | 'contradicted' | 'inconclusive';

export const VERDICTS = ['confirmed', 'contradicted', 'inconclusive'] as const;

export interface ValidationRow {
  id: string;
  inference_id: string;
  observation: string;
  verdict: Verdict;
  note: string | null;
  linked_at: string;
  linked_by: string;
  dataset: Dataset;
}

export interface NewValidation {
  id: string;
  inferenceId: string;
  observation: string;
  verdict: Verdict;
  note: string | null;
  linkedAt: string;
  linkedBy: string;
  dataset: Dataset;
}

const COLUMNS = `id, inference_id, observation, verdict, note,
  to_json(linked_at) #>> '{}' as linked_at, linked_by, dataset`;

@Injectable()
export class InferenceRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  /**
   * Idempotent on (inference, observation). Re-linking the same pair returns
   * the row already there rather than adding a second, so an evaluation set
   * cannot be padded by replaying a request.
   */
  async link(validation: NewValidation): Promise<ValidationRow> {
    const { rows } = await this.pool.query<ValidationRow>(
      `insert into inference.validation
         (id, inference_id, observation, verdict, note, linked_at, linked_by, dataset)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (inference_id, observation) do nothing
       returning ${COLUMNS}`,
      [
        validation.id,
        validation.inferenceId,
        validation.observation,
        validation.verdict,
        validation.note,
        validation.linkedAt,
        validation.linkedBy,
        validation.dataset,
      ],
    );

    const inserted = rows[0];
    if (inserted !== undefined) return inserted;

    const existing = await this.pool.query<ValidationRow>(
      `select ${COLUMNS} from inference.validation
        where inference_id = $1 and observation = $2`,
      [validation.inferenceId, validation.observation],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error('validation insert returned no row');
    return row;
  }

  async validationsFor(
    inferenceIds: readonly string[],
    dataset: Dataset,
  ): Promise<Map<string, ValidationRow[]>> {
    const byInference = new Map<string, ValidationRow[]>();
    if (inferenceIds.length === 0) return byInference;

    const { rows } = await this.pool.query<ValidationRow>(
      `select ${COLUMNS} from inference.validation
        where inference_id = any($1::uuid[]) and dataset = $2
        order by linked_at, id`,
      [[...new Set(inferenceIds)], dataset],
    );

    for (const row of rows) {
      const held = byInference.get(row.inference_id);
      if (held === undefined) byInference.set(row.inference_id, [row]);
      else held.push(row);
    }
    return byInference;
  }

  /**
   * The depth of every named input, for the server-side computation.
   *
   * An id absent from the result is either an observation or not in the corpus
   * at all; both contribute depth 0, and the caller distinguishes them — a
   * missing input is a separate problem from a shallow one.
   */
  async inputDepths(
    ids: readonly string[],
    dataset: Dataset,
  ): Promise<Map<string, number>> {
    const depths = new Map<string, number>();
    if (ids.length === 0) return depths;

    const { rows } = await this.pool.query<{ id: string; depth: number }>(
      `select id, coalesce((body ->> 'inference_depth')::int, 0) as depth
         from inference.record
        where id = any($1::uuid[]) and dataset = $2`,
      [[...new Set(ids)], dataset],
    );

    for (const row of rows) depths.set(row.id, Number(row.depth));
    return depths;
  }

  /** Which of these ids exist as observations, so a bad input is named. */
  async knownObservations(
    ids: readonly string[],
    dataset: Dataset,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { rows } = await this.pool.query<{ id: string }>(
      `select id from facts.record
        where id = any($1::uuid[]) and dataset = $2`,
      [[...new Set(ids)], dataset],
    );
    return new Set(rows.map((row) => row.id));
  }
}
