import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import { containment } from './subjects.js';
import type { CustodyTransferLink } from './custody.js';
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

/** Correlated existence tests, written once so the read path cannot diverge. */
const SUPERSEDED = `exists (select 1 from facts.record s where s.supersedes = r.id)`;
const RETRACTED = `exists (
  select 1 from facts.record t
   where t.type = 'retraction' and t.body ->> 'target' = r.id::text
)`;

/**
 * `superseded_by` is a list because spec §8 rule 4 allows two people to correct
 * the same record. More than one entry is a fork, and the caller is told rather
 * than handed a winner the kernel picked.
 */
const DERIVED = `coalesce(
    (select array_agg(s.id order by s.recorded_at) from facts.record s where s.supersedes = r.id),
    '{}'
  ) as superseded_by,
  ${RETRACTED} as retracted`;

export interface DerivedRecord extends StoredRecord {
  superseded_by: string[];
  retracted: boolean;
}

export interface ListFilter {
  type?: string | undefined;
  assertedBy?: string | undefined;
  /** The party or entity a record is about, matched against declared fields. */
  subject?: { id: string; fields: readonly string[] } | undefined;
  includeSuperseded?: boolean | undefined;
  includeRetracted?: boolean | undefined;
  limit: number;
  cursor?: { recordedAt: string; id: string } | undefined;
}

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

  /**
   * The earliest record in the chain `id` belongs to — walking `supersedes`
   * backwards. A chain is walkable from any point, not just from its origin.
   */
  async findChainOrigin(id: string, maxDepth = 64): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string; depth: number }>(
      `with recursive back as (
         select id, supersedes, 0 as depth from facts.record where id = $1
         union all
         select prior.id, prior.supersedes, back.depth + 1
           from facts.record prior
           join back on back.supersedes = prior.id
          where back.depth < $2
       )
       select id, depth from back order by depth desc limit 1`,
      [id, maxDepth],
    );
    return rows[0]?.id ?? null;
  }

  /** Fetch by id with the derived fields the read path needs. */
  async findByIdWithDerived(id: string): Promise<DerivedRecord | null> {
    const { rows } = await this.pool.query<DerivedRecord>(
      `select ${columnList('r')}, ${DERIVED} from facts.record r where r.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * The default read. Superseded and retracted records are absent unless asked
   * for by id — brief §5 phase 3.
   */
  async list(filter: ListFilter): Promise<DerivedRecord[]> {
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const where: string[] = [];
    if (filter.type !== undefined) where.push(`r.type = ${bind(filter.type)}`);
    if (filter.assertedBy !== undefined) {
      where.push(`r.asserted_by = ${bind(filter.assertedBy)}`);
    }
    if (filter.subject !== undefined) {
      const { id, fields } = filter.subject;
      const matches = fields.map((field) =>
        field === 'id'
          ? `r.id = ${bind(id)}`
          : `r.body @> ${bind(JSON.stringify(containment(field, id)))}::jsonb`,
      );
      where.push(matches.length > 0 ? `(${matches.join(' or ')})` : 'false');
    }
    if (filter.includeSuperseded !== true) where.push(`not ${SUPERSEDED}`);
    if (filter.includeRetracted !== true) where.push(`not ${RETRACTED}`);
    if (filter.cursor !== undefined) {
      where.push(
        `(r.recorded_at, r.id) < (${bind(filter.cursor.recordedAt)}::timestamptz, ${bind(filter.cursor.id)}::uuid)`,
      );
    }

    const { rows } = await this.pool.query<DerivedRecord>(
      `select ${columnList('r')}, ${DERIVED}
         from facts.record r
        ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
        order by r.recorded_at desc, r.id desc
        limit ${bind(filter.limit)}`,
      params,
    );
    return rows;
  }

  /**
   * The replication feed. Ascending by `(recorded_at, id)` so a device can
   * resume where it stopped, and deliberately unfiltered by status: a device
   * replicating the log needs the superseded and retracted records too, or it
   * cannot resolve a chain locally. Brief §5 phase 6.
   *
   * It is scoped to one asserting party. A whole-log feed is the widest
   * disclosure surface in the kernel, and there is no consent implementation
   * that could justify one — see `ConsentService`. A device therefore pulls
   * back what its own party wrote, which is the asserter allowance and nothing
   * more.
   */
  async since(
    after: { recordedAt: string; id: string } | undefined,
    limit: number,
    assertedBy: string,
  ): Promise<DerivedRecord[]> {
    const params: unknown[] = [assertedBy];
    const where = ['r.asserted_by = $1::uuid'];
    if (after !== undefined) {
      params.push(after.recordedAt, after.id);
      where.push(`(r.recorded_at, r.id) > ($2::timestamptz, $3::uuid)`);
    }
    params.push(limit);

    const { rows } = await this.pool.query<DerivedRecord>(
      `select ${columnList('r')}, ${DERIVED}
         from facts.record r
        where ${where.join(' and ')}
        order by r.recorded_at asc, r.id asc
        limit $${params.length}`,
      params,
    );
    return rows;
  }

  /** Which of these ids a retraction targets. One query, not one per record. */
  async retractedAmong(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<{ target: string }>(
      `select distinct body ->> 'target' as target
         from facts.record
        where type = 'retraction' and body ->> 'target' = any($1::text[])`,
      [ids],
    );
    return rows.map((row) => row.target);
  }

  /**
   * Live custody transfers for these lots, oldest first.
   *
   * Superseded and retracted transfers are excluded: a corrected transfer must
   * not move the lot twice, and a retracted one never happened. Ordering falls
   * back to `recorded_at` then `id` so the walk is deterministic when two
   * transfers share an `occurred_at` — which the offline clients make likely.
   */
  async custodyTransfersFor(
    lotIds: readonly string[],
  ): Promise<CustodyTransferLink[]> {
    if (lotIds.length === 0) return [];
    const { rows } = await this.pool.query<CustodyTransferLink>(
      `select r.id,
              r.body ->> 'lot'         as lot,
              r.body ->> 'from_party'  as from_party,
              r.body ->> 'to_party'    as to_party,
              to_char(r.occurred_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at
         from facts.record r
        where r.type = 'custody_transfer'
          and r.body ->> 'lot' = any($1::text[])
          and not ${SUPERSEDED}
          and not ${RETRACTED}
        order by r.occurred_at, r.recorded_at, r.id`,
      [[...new Set(lotIds)]],
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
