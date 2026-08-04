import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';

export interface UnanchoredRecord {
  id: string;
  record_class: 'observation' | 'inference';
  type: string;
  recorded_at: string;
}

export interface AnchorBatchRow {
  id: string;
  dataset: string;
  batch_date: string;
  record_count: number;
  merkle_root: string;
  state: 'pending' | 'published' | 'failed';
  attempts: number;
  last_error: string | null;
  network: 'testnet' | 'mainnet';
  topic_id: string | null;
  sequence_number: string | null;
  consensus_at: string | null;
  transaction_id: string | null;
}

export interface AnchorLeafRow {
  batch_id: string;
  record_id: string;
  position: number;
  salt: string;
  record_digest: string;
  leaf_hash: string;
}

export interface NewLeaf {
  record_id: string;
  position: number;
  salt: string;
  record_digest: string;
  leaf_hash: string;
}

const BATCH_COLUMNS = `
  id,
  dataset,
  to_json(batch_date) #>> '{}' as batch_date,
  record_count,
  merkle_root,
  state,
  attempts,
  last_error,
  network,
  topic_id,
  sequence_number::text as sequence_number,
  to_json(consensus_at) #>> '{}' as consensus_at,
  transaction_id
`;

@Injectable()
export class AnchorRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  /**
   * Live records written on or before the end of the day, not yet in any tree.
   *
   * Not "written on that day". A record that arrived late from an offline
   * device, or one whose batch failed to publish, is picked up by the next run
   * rather than being stranded on a day that has already been anchored — which
   * is what "a network failure delays a batch, never drops records" means in
   * practice.
   */
  async unanchored(before: string, limit: number): Promise<UnanchoredRecord[]> {
    const { rows } = await this.pool.query<UnanchoredRecord>(
      `select id,
              record_class,
              type,
              to_json(recorded_at) #>> '{}' as recorded_at
         from kernel.unanchored_record
        where recorded_at < ($1::date + 1)
        order by recorded_at, id
        limit $2`,
      [before, limit],
    );
    return rows;
  }

  /** The record bodies, in the order the ids were given. */
  async bodies(ids: readonly string[]): Promise<Map<string, unknown>> {
    if (ids.length === 0) return new Map();

    const { rows } = await this.pool.query<{ id: string; document: unknown }>(
      `select id, document from (
         select r.id,
                to_jsonb(r) - 'dataset' as document
           from facts.record r
          where r.id = any($1::uuid[])
          union all
         select i.id,
                to_jsonb(i) - 'dataset' as document
           from inference.record i
          where i.id = any($1::uuid[])
       ) both_logs`,
      [ids],
    );
    return new Map(rows.map((row) => [row.id, row.document]));
  }

  async batchFor(date: string): Promise<AnchorBatchRow | null> {
    const { rows } = await this.pool.query<AnchorBatchRow>(
      `select ${BATCH_COLUMNS} from kernel.anchor_batch
        where dataset = 'live' and batch_date = $1::date`,
      [date],
    );
    return rows[0] ?? null;
  }

  async batchById(id: string): Promise<AnchorBatchRow | null> {
    const { rows } = await this.pool.query<AnchorBatchRow>(
      `select ${BATCH_COLUMNS} from kernel.anchor_batch where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async pending(limit: number): Promise<AnchorBatchRow[]> {
    const { rows } = await this.pool.query<AnchorBatchRow>(
      `select ${BATCH_COLUMNS} from kernel.anchor_batch
        where state <> 'published'
        order by batch_date
        limit $1`,
      [limit],
    );
    return rows;
  }

  /**
   * The batch and all its leaves, or neither.
   *
   * A root stored without its leaves is a root nobody can ever produce a proof
   * against, and a leaf stored without its root has claimed a record that no
   * later batch can pick up. One transaction.
   */
  async createBatch(batch: {
    id: string;
    date: string;
    root: string;
    network: 'testnet' | 'mainnet';
    leaves: readonly NewLeaf[];
  }): Promise<AnchorBatchRow> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('begin');

      const { rows } = await client.query<AnchorBatchRow>(
        `insert into kernel.anchor_batch
           (id, dataset, batch_date, record_count, merkle_root, network)
         values ($1, 'live', $2::date, $3, $4, $5)
         on conflict (dataset, batch_date) do nothing
         returning ${BATCH_COLUMNS}`,
        [batch.id, batch.date, batch.leaves.length, batch.root, batch.network],
      );

      const created = rows[0];
      if (created === undefined) {
        // Another run got there first. Re-running a day is a no-op, not a
        // second root.
        await client.query('rollback');
        const existing = await this.batchFor(batch.date);
        if (existing === null) throw new Error('the batch vanished mid-flight');
        return existing;
      }

      await client.query(
        `insert into kernel.anchor_leaf
           (batch_id, record_id, position, salt, record_digest, leaf_hash)
         select $1,
                unnest($2::uuid[]),
                unnest($3::int[]),
                unnest($4::text[]),
                unnest($5::text[]),
                unnest($6::text[])`,
        [
          batch.id,
          batch.leaves.map((leaf) => leaf.record_id),
          batch.leaves.map((leaf) => leaf.position),
          batch.leaves.map((leaf) => leaf.salt),
          batch.leaves.map((leaf) => leaf.record_digest),
          batch.leaves.map((leaf) => leaf.leaf_hash),
        ],
      );

      await client.query('commit');
      return created;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async leaves(batchId: string): Promise<AnchorLeafRow[]> {
    const { rows } = await this.pool.query<AnchorLeafRow>(
      `select batch_id, record_id, position, salt, record_digest, leaf_hash
         from kernel.anchor_leaf
        where batch_id = $1
        order by position`,
      [batchId],
    );
    return rows;
  }

  async leafFor(recordId: string): Promise<AnchorLeafRow | null> {
    const { rows } = await this.pool.query<AnchorLeafRow>(
      `select batch_id, record_id, position, salt, record_digest, leaf_hash
         from kernel.anchor_leaf
        where record_id = $1`,
      [recordId],
    );
    return rows[0] ?? null;
  }

  async markPublished(
    id: string,
    receipt: {
      topicId: string;
      sequenceNumber: string;
      consensusAt: Date;
      transactionId: string | null;
    },
  ): Promise<AnchorBatchRow | null> {
    const { rows } = await this.pool.query<AnchorBatchRow>(
      `update kernel.anchor_batch
          set state = 'published',
              topic_id = $2,
              sequence_number = $3::bigint,
              consensus_at = $4,
              transaction_id = $5,
              last_error = null
        where id = $1 and state <> 'published'
        returning ${BATCH_COLUMNS}`,
      [
        id,
        receipt.topicId,
        receipt.sequenceNumber,
        receipt.consensusAt,
        receipt.transactionId,
      ],
    );
    return rows[0] ?? null;
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `update kernel.anchor_batch
          set state = 'failed', attempts = attempts + 1, last_error = $2
        where id = $1 and state <> 'published'`,
      [id, error.slice(0, 2000)],
    );
  }

  /** Roots only, for a verifier and for the backup manifest. */
  async publishedBatches(): Promise<AnchorBatchRow[]> {
    const { rows } = await this.pool.query<AnchorBatchRow>(
      `select ${BATCH_COLUMNS} from kernel.anchor_batch
        where state = 'published'
        order by batch_date`,
    );
    return rows;
  }

  async publishedRoots(): Promise<
    { batch_date: string; merkle_root: string; record_count: number }[]
  > {
    const { rows } = await this.pool.query<{
      batch_date: string;
      merkle_root: string;
      record_count: number;
    }>(
      `select to_json(batch_date) #>> '{}' as batch_date, merkle_root, record_count
         from kernel.published_root
        order by batch_date`,
    );
    return rows;
  }
}
