import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import type { RecordClass, StoredRecord } from './record.js';

/**
 * Timestamps are rendered as RFC 3339 in UTC (spec §2.2: store UTC, render
 * local). Doing it in SQL rather than in JavaScript keeps the driver's Date
 * conversion — and its local-timezone assumptions — off the read path.
 */
const PLAIN_COLUMNS = [
  'id',
  'type',
  'record_class',
  'schema_version',
  'occurred_at_precision',
  'asserted_by',
  'authenticated_as',
  'on_behalf_of',
  'delegation',
  'device_id',
  'supersedes',
  'body',
  'ext',
  'quality_flags',
];

const TIMESTAMP_COLUMNS = ['occurred_at', 'recorded_at'];

/** `alias` must be supplied wherever the query joins, or `id` is ambiguous. */
const columnList = (alias = ''): string => {
  const q = alias === '' ? '' : `${alias}.`;
  return [
    ...PLAIN_COLUMNS.map((column) => `${q}${column}`),
    ...TIMESTAMP_COLUMNS.map(
      (column) =>
        `to_char(${q}${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${column}`,
    ),
  ].join(', ');
};

const COLUMNS = columnList();

const NAMESPACE: Record<RecordClass, string> = {
  observation: 'facts.record',
  inference: 'inference.record',
};

export interface AppendResult {
  record: StoredRecord;
  /** True when this id had already been ingested. Brief §4 invariant 5. */
  replayed: boolean;
}

@Injectable()
export class RecordRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  /**
   * Append a record, or return the one already stored under that id.
   *
   * Idempotency rests on the primary key of `kernel.record_key` rather than on
   * a read-then-write check, so two devices replaying the same outbox entry
   * concurrently cannot both insert.
   */
  async appendIfAbsent(record: StoredRecord): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const claimed = await client.query(
        `insert into kernel.record_key (id, record_class, type, recorded_at)
         values ($1, $2, $3, $4)
         on conflict (id) do nothing
         returning id`,
        [record.id, record.record_class, record.type, record.recorded_at],
      );

      if (claimed.rowCount === 0) {
        const existing = await this.findByIdWith(client, record.id);
        await client.query('commit');
        if (!existing) {
          // The id is claimed but the record is absent. That can only happen if
          // something wrote to the registry outside this method.
          throw new Error(
            `record ${record.id} is registered but not stored — the registry and the log disagree`,
          );
        }
        return { record: existing, replayed: true };
      }

      const table = NAMESPACE[record.record_class];
      await client.query(
        `insert into ${table} (
           id, type, record_class, schema_version,
           occurred_at, occurred_at_precision, recorded_at,
           asserted_by, authenticated_as, on_behalf_of, delegation,
           device_id, supersedes, body, ext, quality_flags
         ) values (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, $10, $11,
           $12, $13, $14, $15, $16
         )`,
        [
          record.id,
          record.type,
          record.record_class,
          record.schema_version,
          record.occurred_at,
          record.occurred_at_precision,
          record.recorded_at,
          record.asserted_by,
          record.authenticated_as,
          record.on_behalf_of,
          record.delegation,
          record.device_id,
          record.supersedes,
          JSON.stringify(record.body),
          JSON.stringify(record.ext),
          record.quality_flags,
        ],
      );

      await client.query('commit');
      return { record, replayed: false };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Fetch by id from the fact log. Inferences are not reachable from here. */
  async findById(id: string): Promise<StoredRecord | null> {
    const { rows } = await this.pool.query<StoredRecord>(
      `select ${COLUMNS} from facts.record where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Fetch by id from the inference namespace. Callers must ask for this
   * explicitly; nothing on a default read path calls it. Spec §6.2 rule 1.
   */
  async findInferenceById(id: string): Promise<StoredRecord | null> {
    const { rows } = await this.pool.query<StoredRecord>(
      `select ${COLUMNS} from inference.record where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** The record that supersedes `id`, if one exists. Spec §8. */
  async findSupersederOf(id: string): Promise<StoredRecord[]> {
    const { rows } = await this.pool.query<StoredRecord>(
      `select ${COLUMNS} from facts.record where supersedes = $1 order by recorded_at`,
      [id],
    );
    return rows;
  }

  /**
   * Every record reachable forward from `id` along `supersedes`, nearest first.
   *
   * Spec §8 rule 3 permits chains and rejects cycles; the depth bound is what
   * stops a cycle that predates that check from spinning. Rule 4 permits forks,
   * which is why this returns a list rather than a single tip — two officers
   * correcting the same delivery is a dispute to surface, not to auto-merge.
   */
  async findSupersessionChain(
    id: string,
    maxDepth = 64,
  ): Promise<Array<StoredRecord & { depth: number }>> {
    const { rows } = await this.pool.query<StoredRecord & { depth: number }>(
      `with recursive chain as (
         select id, 0 as depth from facts.record where id = $1
         union all
         select next.id, chain.depth + 1
           from facts.record next
           join chain on next.supersedes = chain.id
          where chain.depth < $2
       )
       select ${columnList('r')}, chain.depth
         from facts.record r
         join chain on chain.id = r.id
        order by chain.depth, r.recorded_at`,
      [id, maxDepth],
    );
    return rows;
  }

  /** True if any retraction targets this id. Spec §8.1. */
  async isRetracted(id: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ retracted: boolean }>(
      `select exists (
         select 1 from facts.record
          where type = 'retraction' and body ->> 'target' = $1
       ) as retracted`,
      [id],
    );
    return rows[0]?.retracted ?? false;
  }

  private async findByIdWith(
    client: PoolClient,
    id: string,
  ): Promise<StoredRecord | null> {
    const { rows } = await client.query<{ record_class: RecordClass }>(
      'select record_class from kernel.record_key where id = $1',
      [id],
    );
    const recordClass = rows[0]?.record_class;
    if (!recordClass) return null;

    const found = await client.query<StoredRecord>(
      `select ${COLUMNS} from ${NAMESPACE[recordClass]} where id = $1`,
      [id],
    );
    return found.rows[0] ?? null;
  }
}
