import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import { containment, type SubjectTarget } from './subjects.js';
import type { DeliveryTally } from './fulfilment.js';
import type { DeclaredLoss, WeighedTransfer } from './mass-balance.js';
import type { SettlementGroup } from './settlement.js';
import type { Dataset, RecordClass, StoredRecord } from './record.js';

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
  'dataset',
  'lawful_basis',
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

/**
 * Correlated existence tests, written once so the read path cannot diverge.
 *
 * Every one is dataset-local. A fabricated retraction must not hide a real
 * record, and a fabricated correction must not fork a real chain — putting the
 * check here means no future query can forget it.
 */
const SUPERSEDED = `exists (
  select 1 from facts.record s
   where s.supersedes = r.id and s.dataset = r.dataset
)`;
const RETRACTED = `exists (
  select 1 from facts.record t
   where t.type = 'retraction'
     and t.body ->> 'target' = r.id::text
     and t.dataset = r.dataset
)`;

/**
 * `superseded_by` is a list because spec §8 rule 4 allows two people to correct
 * the same record. More than one entry is a fork, and the caller is told rather
 * than handed a winner the kernel picked.
 */
const DERIVED = `coalesce(
    (select array_agg(s.id order by s.recorded_at)
       from facts.record s
      where s.supersedes = r.id and s.dataset = r.dataset),
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
  dataset: Dataset;
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
        `insert into kernel.record_key (id, record_class, type, recorded_at, dataset)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do nothing
         returning id`,
        [
          record.id,
          record.record_class,
          record.type,
          record.recorded_at,
          record.dataset,
        ],
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
           device_id, supersedes, body, ext, quality_flags, dataset,
           lawful_basis
         ) values (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, $10, $11,
           $12, $13, $14, $15, $16, $17, $18
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
          record.dataset,
          record.lawful_basis,
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

  /**
   * How many live records rest on each DPPA ground, and how many of those are
   * financial records — s.9(1) special data — resting on something other than
   * the s.9(3)(b) consent that alone permits them.
   *
   * The second number should be zero for anything written after 0013, because
   * ingest refuses it. It is reported anyway: a non-zero value means either a
   * pre-0013 record or a hole in the check, and both are worth seeing without
   * having to go and look.
   */
  async lawfulBasisCensus(): Promise<
    Array<{ basis: string; financial: boolean; records: number }>
  > {
    const { rows } = await this.pool.query<{
      basis: string;
      financial: boolean;
      records: string;
    }>(
      `select coalesce(r.lawful_basis, 'unstated') as basis,
              (r.type in ('obligation', 'settlement_reference')
                 or (r.type = 'delivery'
                     and r.body -> 'agreed_price' is not null)) as financial,
              count(*) as records
         from facts.record r
        where r.dataset = 'live'
        group by 1, 2`,
    );
    return rows.map((row) => ({
      basis: row.basis,
      financial: row.financial,
      records: Number(row.records),
    }));
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

    const where: string[] = [`r.dataset = ${bind(filter.dataset)}`];
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
    dataset: Dataset,
  ): Promise<DerivedRecord[]> {
    const params: unknown[] = [assertedBy, dataset];
    const where = ['r.asserted_by = $1::uuid', 'r.dataset = $2'];
    if (after !== undefined) {
      params.push(after.recordedAt, after.id);
      where.push(`(r.recorded_at, r.id) > ($3::timestamptz, $4::uuid)`);
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

  /**
   * What has been delivered against each of these agreements.
   *
   * Aggregated in SQL so a busy agreement does not pull every delivery across
   * the wire. Superseded and retracted deliveries are excluded — a corrected
   * delivery must count once, and a retracted one not at all.
   */
  async deliveryTallies(
    agreementIds: readonly string[],
    dataset: Dataset,
  ): Promise<Map<string, DeliveryTally>> {
    if (agreementIds.length === 0) return new Map();
    const { rows } = await this.pool.query<DeliveryTally & { agreement: string }>(
      `select r.body ->> 'fulfils' as agreement,
              count(*)::int as deliveries,
              count(*) filter (
                where r.body ->> 'counterparty_confirmed_at' is not null
              )::int as confirmed,
              count(*) filter (
                where r.body -> 'quantity' ->> 'normalized_kg' is null
              )::int as unconvertible,
              coalesce(
                sum((r.body -> 'quantity' ->> 'normalized_kg')::numeric), 0
              )::float8 as delivered_kg
         from facts.record r
        where r.type = 'delivery'
          and r.body ->> 'fulfils' = any($1::text[])
          and r.dataset = $2
          and not ${SUPERSEDED}
          and not ${RETRACTED}
        group by 1`,
      [[...new Set(agreementIds)], dataset],
    );

    return new Map(
      rows.map(({ agreement, ...tally }) => [agreement, tally]),
    );
  }

  /**
   * Settlement references against these obligations, grouped by currency and
   * verification status.
   *
   * Grouped rather than totalled because the caller must not be handed one
   * number: an asserted settlement and a provider-verified one are different
   * evidence, and settlements in another currency are not addable at all.
   *
   * There is no counterpart method keyed on a party. See `settlement.ts`.
   */
  async settlementGroups(
    obligationIds: readonly string[],
    dataset: Dataset,
  ): Promise<SettlementGroup[]> {
    if (obligationIds.length === 0) return [];
    const { rows } = await this.pool.query<
      Omit<SettlementGroup, 'amount_minor'> & { amount_minor: string }
    >(
      `select r.body ->> 'obligation'                as obligation,
              r.body -> 'amount' ->> 'currency'      as currency,
              r.body ->> 'verification_status'       as verification_status,
              count(*)::int                          as records,
              coalesce(
                sum((r.body -> 'amount' ->> 'amount_minor')::bigint), 0
              )::text                                as amount_minor
         from facts.record r
        where r.type = 'settlement_reference'
          and r.body ->> 'obligation' = any($1::text[])
          and r.dataset = $2
          and not ${SUPERSEDED}
          and not ${RETRACTED}
        group by 1, 2, 3`,
      [[...new Set(obligationIds)], dataset],
    );

    return rows.map((row) => ({
      ...row,
      amount_minor: Number(row.amount_minor),
    }));
  }

  /**
   * The type of each of these ids, and whether it has been retracted.
   *
   * Superseded records still count as present: a corrected lot is still a lot,
   * and an observation about it is about something real.
   */
  async recordTypesOf(
    ids: readonly string[],
    dataset: Dataset,
  ): Promise<Map<string, SubjectTarget>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool.query<{ id: string } & SubjectTarget>(
      `select r.id, r.type, ${RETRACTED} as retracted
         from facts.record r
        where r.id = any($1::uuid[]) and r.dataset = $2`,
      [[...new Set(ids)], dataset],
    );
    return new Map(rows.map(({ id, ...target }) => [id, target]));
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
    dataset: Dataset,
  ): Promise<WeighedTransfer[]> {
    if (lotIds.length === 0) return [];
    const { rows } = await this.pool.query<WeighedTransfer>(
      `select r.id,
              r.body ->> 'lot'         as lot,
              r.body ->> 'from_party'  as from_party,
              r.body ->> 'to_party'    as to_party,
              (r.body -> 'quantity' ->> 'normalized_kg')::float8 as weighed_kg,
              to_char(r.occurred_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at
         from facts.record r
        where r.type = 'custody_transfer'
          and r.body ->> 'lot' = any($1::text[])
          and r.dataset = $2
          and not ${SUPERSEDED}
          and not ${RETRACTED}
        order by r.occurred_at, r.recorded_at, r.id`,
      [[...new Set(lotIds)], dataset],
    );
    return rows;
  }

  /**
   * `loss.declared` Observations against these lots. Spec §9.1 — a loss is an
   * event with an author and a time, not a field on the lot. See decision 0011.
   *
   * Only the `quantity` kind counts, and only once it has been normalized. A
   * loss whose `normalized_kg` is null yields null here rather than a converted
   * guess: the kernel does not invent the factor it was not given.
   */
  async declaredLossesFor(
    lotIds: readonly string[],
    dataset: Dataset,
  ): Promise<DeclaredLoss[]> {
    if (lotIds.length === 0) return [];
    const { rows } = await this.pool.query<DeclaredLoss>(
      `select r.id,
              r.body ->> 'subject_ref' as lot,
              case when r.body -> 'value' ->> 'kind' = 'quantity'
                   then (r.body -> 'value' -> 'value' ->> 'normalized_kg')::float8
              end as kg,
              to_char(r.occurred_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at
         from facts.record r
        where r.type = 'observation'
          and r.body ->> 'observation_type' = 'loss.declared'
          and r.body ->> 'subject_type' = 'lot'
          and r.body ->> 'subject_ref' = any($1::text[])
          and r.dataset = $2
          and not ${SUPERSEDED}
          and not ${RETRACTED}
        order by r.occurred_at, r.recorded_at, r.id`,
      [[...new Set(lotIds)], dataset],
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
