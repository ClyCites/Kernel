import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';

export interface MediaObjectRow {
  content_hash: string;
  dataset: string;
  received_hash: string;
  mime_type: string;
  byte_size: number;
  received_size: number;
  storage_ref: string;
  metadata_stripped: boolean;
  first_seen_at: string;
  first_seen_by: string;
}

export interface NewMediaObject {
  contentHash: string;
  dataset: string;
  receivedHash: string;
  mimeType: string;
  byteSize: number;
  receivedSize: number;
  storageRef: string;
  metadataStripped: boolean;
  firstSeenBy: string;
}

export interface UploadSessionRow {
  id: string;
  declared_hash: string;
  declared_mime: string;
  declared_size: number;
  received_size: number;
  state: 'open' | 'complete' | 'rejected';
  rejection: string | null;
  content_hash: string | null;
  started_by: string;
  dataset: string;
  expires_at: string;
}

export interface ChunkRow {
  chunk_offset: number;
  byte_length: number;
  storage_ref: string;
}

export interface InventoryRow {
  dataset: string;
  object_count: number;
  byte_total: number;
  digest: string;
}

const OBJECT_COLUMNS = `
  content_hash, dataset, received_hash, mime_type,
  byte_size::bigint as byte_size, received_size::bigint as received_size,
  storage_ref, metadata_stripped,
  to_json(first_seen_at) #>> '{}' as first_seen_at, first_seen_by`;

const SESSION_COLUMNS = `
  id, declared_hash, declared_mime,
  declared_size::bigint as declared_size, received_size::bigint as received_size,
  state, rejection, content_hash, started_by, dataset,
  to_json(expires_at) #>> '{}' as expires_at`;

@Injectable()
export class MediaRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  /* ── objects ───────────────────────────────────────────────────────────── */

  /**
   * Register a stored object, or return the one already registered.
   *
   * Content-addressed storage means a second upload of the same photograph is
   * not a conflict, it is the same object. `do nothing` then re-select keeps
   * the first registration — including who first supplied it, which is the
   * honest answer to "where did this come from" and would be lost by an
   * upsert.
   */
  async register(object: NewMediaObject): Promise<MediaObjectRow> {
    await this.pool.query(
      `insert into kernel.media_object (
         content_hash, dataset, received_hash, mime_type, byte_size,
         received_size, storage_ref, metadata_stripped, first_seen_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (content_hash, dataset) do nothing`,
      [
        object.contentHash,
        object.dataset,
        object.receivedHash,
        object.mimeType,
        object.byteSize,
        object.receivedSize,
        object.storageRef,
        object.metadataStripped,
        object.firstSeenBy,
      ],
    );

    const found = await this.object(object.contentHash, object.dataset);
    if (found === null) {
      throw new Error(`media object ${object.contentHash} vanished after insert`);
    }
    return found;
  }

  async object(contentHash: string, dataset: string): Promise<MediaObjectRow | null> {
    const result = await this.pool.query<MediaObjectRow>(
      `select ${OBJECT_COLUMNS} from kernel.media_object
        where content_hash = $1 and dataset = $2`,
      [contentHash, dataset],
    );
    return result.rows[0] ?? null;
  }

  /* ── references ────────────────────────────────────────────────────────── */

  async cite(
    hashes: readonly string[],
    recordId: string,
    recordClass: string,
    dataset: string,
  ): Promise<void> {
    if (hashes.length === 0) return;
    await this.pool.query(
      `insert into kernel.media_reference (content_hash, record_id, record_class, dataset)
       select unnest($1::text[]), $2, $3, $4
       on conflict (content_hash, record_id) do nothing`,
      [[...new Set(hashes)], recordId, recordClass, dataset],
    );
  }

  /**
   * Which records cite this object. The read guard runs against these, so an
   * object nothing cites is unreachable — which is correct, not a gap: bytes
   * with no record behind them have no consent basis to be released under.
   */
  async citedBy(
    contentHash: string,
    dataset: string,
  ): Promise<{ record_id: string; record_class: string }[]> {
    const result = await this.pool.query<{ record_id: string; record_class: string }>(
      `select record_id, record_class from kernel.media_reference
        where content_hash = $1 and dataset = $2
        order by cited_at`,
      [contentHash, dataset],
    );
    return result.rows;
  }

  /* ── upload sessions ───────────────────────────────────────────────────── */

  async open(session: {
    id: string;
    declaredHash: string;
    declaredMime: string;
    declaredSize: number;
    startedBy: string;
    dataset: string;
    expiresAt: string;
  }): Promise<UploadSessionRow> {
    const result = await this.pool.query<UploadSessionRow>(
      `insert into kernel.upload_session (
         id, declared_hash, declared_mime, declared_size, started_by, dataset, expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7)
       returning ${SESSION_COLUMNS}`,
      [
        session.id,
        session.declaredHash,
        session.declaredMime,
        session.declaredSize,
        session.startedBy,
        session.dataset,
        session.expiresAt,
      ],
    );
    return result.rows[0]!;
  }

  async session(id: string, dataset: string): Promise<UploadSessionRow | null> {
    const result = await this.pool.query<UploadSessionRow>(
      `select ${SESSION_COLUMNS} from kernel.upload_session
        where id = $1 and dataset = $2`,
      [id, dataset],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Record a received chunk and advance the offset, in one statement.
   *
   * The `where received_size = $2` is the concurrency control. Two PATCHes
   * claiming the same offset must not both succeed: the second would advance
   * the offset past bytes nobody sent, and the assembled file would be
   * garbage that still hashed to something. Returning no row is how the caller
   * learns it lost, and 409 is what tus says to answer.
   */
  async advance(
    sessionId: string,
    offset: number,
    length: number,
    storageRef: string,
  ): Promise<UploadSessionRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const advanced = await client.query<UploadSessionRow>(
        `update kernel.upload_session
            set received_size = received_size + $3, updated_at = now()
          where id = $1 and received_size = $2 and state = 'open'
          returning ${SESSION_COLUMNS}`,
        [sessionId, offset, length],
      );
      if (advanced.rows.length === 0) {
        await client.query('rollback');
        return null;
      }
      await client.query(
        `insert into kernel.upload_chunk (session_id, chunk_offset, byte_length, storage_ref)
         values ($1, $2, $3, $4)`,
        [sessionId, offset, length, storageRef],
      );
      await client.query('commit');
      return advanced.rows[0]!;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async chunks(sessionId: string): Promise<ChunkRow[]> {
    const result = await this.pool.query<ChunkRow>(
      `select chunk_offset::bigint as chunk_offset,
              byte_length::bigint as byte_length,
              storage_ref
         from kernel.upload_chunk
        where session_id = $1
        order by chunk_offset`,
      [sessionId],
    );
    return result.rows;
  }

  async complete(sessionId: string, contentHash: string): Promise<void> {
    await this.pool.query(
      `update kernel.upload_session
          set state = 'complete', content_hash = $2, updated_at = now()
        where id = $1`,
      [sessionId, contentHash],
    );
  }

  async reject(sessionId: string, reason: string): Promise<void> {
    await this.pool.query(
      `update kernel.upload_session
          set state = 'rejected', rejection = $2, updated_at = now()
        where id = $1`,
      [sessionId, reason],
    );
  }

  async discardChunks(sessionId: string): Promise<void> {
    await this.pool.query(`delete from kernel.upload_chunk where session_id = $1`, [
      sessionId,
    ]);
  }

  /* ── inventory ─────────────────────────────────────────────────────────── */

  async inventory(dataset: string): Promise<InventoryRow> {
    const result = await this.pool.query<InventoryRow>(
      `select dataset, object_count::bigint as object_count,
              byte_total::bigint as byte_total, digest
         from kernel.object_inventory where dataset = $1`,
      [dataset],
    );
    return (
      result.rows[0] ?? { dataset, object_count: 0, byte_total: 0, digest: 'empty' }
    );
  }

  async storageRefs(dataset: string): Promise<string[]> {
    const result = await this.pool.query<{ storage_ref: string }>(
      `select storage_ref from kernel.media_object
        where dataset = $1 order by content_hash`,
      [dataset],
    );
    return result.rows.map((row) => row.storage_ref);
  }
}
