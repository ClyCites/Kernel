import { Inject, Injectable, Optional } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { AuditService } from '../audit/audit.service.js';
import { ReadService, type Reader } from '../records/read.service.js';
import type { Dataset } from '../records/record.js';
import { subjectsOf } from '../records/subjects.js';
import {
  ALLOWED_MIME,
  MAX_CHUNK_BYTES,
  MAX_OBJECT_BYTES,
  MediaRejected,
  sha256,
  sniff,
  strip,
  type AllowedMime,
} from './format.js';
import { MediaRepository, type MediaObjectRow, type UploadSessionRow } from './media.repository.js';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  objectKey,
  OBJECT_STORE,
  ObjectStore,
  stagingKey,
} from './objects.js';

/**
 * How long an abandoned upload survives. Long enough to cross a night without
 * signal; short enough that staging does not accumulate forever.
 */
const SESSION_TTL_HOURS = 48;

export const MEDIA_HASH_MISMATCH = 'hash_mismatch';
export const MEDIA_TYPE_REFUSED = 'type_refused';
export const MEDIA_TOO_LARGE = 'too_large';
export const MEDIA_SIZE_MISMATCH = 'size_mismatch';

export class MediaUnavailable extends Error {
  constructor() {
    super('no object store is configured');
    this.name = 'MediaUnavailable';
  }
}

export interface UploadContext {
  requester: string;
  dataset: string;
  correlation: string | null;
}

export interface CompletedUpload {
  session: UploadSessionRow;
  object: MediaObjectRow | null;
}

@Injectable()
export class MediaService {
  constructor(
    @Inject(MediaRepository) private readonly media: MediaRepository,
    @Inject(ReadService) private readonly reads: ReadService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(OBJECT_STORE) private readonly store: ObjectStore | null = null,
  ) {}

  get configured(): boolean {
    return this.store !== null;
  }

  /* ── creating an upload ────────────────────────────────────────────────── */

  /**
   * Begin a resumable upload. The client states what it is about to send; none
   * of it is believed, all of it is checked when the bytes arrive.
   *
   * The declared type and size are checked here anyway, because refusing a
   * 200MB executable before it is transferred is a kindness to a metered
   * connection.
   */
  async begin(
    declared: { hash: string; mime: string; size: number },
    context: UploadContext,
  ): Promise<UploadSessionRow> {
    // Opening a session against a kernel with no store would hand the client a
    // resumable upload that can never complete.
    this.require();

    if (!/^[0-9a-f]{64}$/u.test(declared.hash)) {
      throw new MediaRejected(MEDIA_HASH_MISMATCH, 'the declared hash is not a SHA-256');
    }
    if (!(ALLOWED_MIME as readonly string[]).includes(declared.mime)) {
      throw new MediaRejected(
        MEDIA_TYPE_REFUSED,
        `${declared.mime} is not an accepted type`,
      );
    }
    if (declared.size <= 0 || declared.size > MAX_OBJECT_BYTES) {
      throw new MediaRejected(
        MEDIA_TOO_LARGE,
        `${declared.size} bytes is outside the accepted range`,
      );
    }

    const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
    const session = await this.media.open({
      id: uuidv7(),
      declaredHash: declared.hash,
      declaredMime: declared.mime,
      declaredSize: declared.size,
      startedBy: context.requester,
      dataset: context.dataset,
      expiresAt: expires.toISOString(),
    });

    await this.audit.record({
      action: 'media.write',
      outcome: 'allowed',
      dataset: context.dataset as Dataset,
      actor: context.requester,
      reason: 'upload_begun',
      correlationId: context.correlation,
      detail: { session: session.id, declared_bytes: Number(session.declared_size) },
    });

    return session;
  }

  async session(id: string, dataset: string): Promise<UploadSessionRow | null> {
    return this.media.session(id, dataset);
  }

  /* ── receiving bytes ───────────────────────────────────────────────────── */

  /**
   * Accept one chunk at a stated offset, and assemble when the last one lands.
   *
   * Returns null when the offset does not match what the server has — tus says
   * 409, and the client's next move is a HEAD to find out where it actually
   * got to. That is the resume.
   */
  async receive(
    sessionId: string,
    offset: number,
    body: Buffer,
    context: UploadContext,
  ): Promise<CompletedUpload | null> {
    const store = this.require();

    const session = await this.media.session(sessionId, context.dataset);
    if (session === null || session.state !== 'open') return null;
    if (session.started_by !== context.requester) return null;
    if (offset !== Number(session.received_size)) return null;
    if (body.length === 0 || body.length > MAX_CHUNK_BYTES) return null;
    if (offset + body.length > Number(session.declared_size)) {
      // More bytes than were declared. Not a resume race — the client is
      // sending a different file than the one it announced.
      await this.media.reject(sessionId, MEDIA_SIZE_MISMATCH);
      return { session: { ...session, state: 'rejected', rejection: MEDIA_SIZE_MISMATCH }, object: null };
    }

    const key = stagingKey(sessionId, offset);
    await store.put(key, body, 'application/octet-stream');

    const advanced = await this.media.advance(sessionId, offset, body.length, key);
    if (advanced === null) {
      // Somebody else advanced it first. Drop the staged bytes rather than
      // leaving an orphan nothing will ever collect.
      await store.delete(key);
      return null;
    }

    if (Number(advanced.received_size) < Number(advanced.declared_size)) {
      return { session: advanced, object: null };
    }
    return this.assemble(advanced, context);
  }

  /**
   * The last byte has arrived. Reassemble, check, strip, store.
   */
  private async assemble(
    session: UploadSessionRow,
    context: UploadContext,
  ): Promise<CompletedUpload> {
    const store = this.require();
    const chunks = await this.media.chunks(session.id);

    const parts: Buffer[] = [];
    let expected = 0;
    for (const chunk of chunks) {
      if (Number(chunk.chunk_offset) !== expected) {
        // Should be unreachable: the offset check on every PATCH is what makes
        // the sequence contiguous. If it ever fires, the alternative is
        // storing a file with a hole in it.
        await this.fail(session, MEDIA_SIZE_MISMATCH, context);
        return { session: { ...session, state: 'rejected', rejection: MEDIA_SIZE_MISMATCH }, object: null };
      }
      parts.push(await store.get(chunk.storage_ref));
      expected += Number(chunk.byte_length);
    }

    const received = Buffer.concat(parts);

    // ── the claim, checked ────────────────────────────────────────────────
    //
    // This is the mismatch that is a correct rejection. The hash is what gets
    // anchored; accepting bytes that do not match the claim would anchor a
    // statement about a file nobody has.
    const receivedHash = sha256(received);
    if (receivedHash !== session.declared_hash) {
      await this.fail(session, MEDIA_HASH_MISMATCH, context);
      return {
        session: { ...session, state: 'rejected', rejection: MEDIA_HASH_MISMATCH },
        object: null,
      };
    }

    // ── what the bytes actually are ───────────────────────────────────────
    const actual = sniff(received);
    if (actual === null || actual !== session.declared_mime) {
      await this.fail(session, MEDIA_TYPE_REFUSED, context);
      return {
        session: { ...session, state: 'rejected', rejection: MEDIA_TYPE_REFUSED },
        object: null,
      };
    }

    let stripped;
    try {
      stripped = strip(actual as AllowedMime, received);
    } catch {
      await this.fail(session, MEDIA_TYPE_REFUSED, context);
      return {
        session: { ...session, state: 'rejected', rejection: MEDIA_TYPE_REFUSED },
        object: null,
      };
    }

    // The stored hash is over the stripped bytes, because those are the bytes
    // a verifier can fetch. See docs/decisions/0037.
    const contentHash = sha256(stripped.bytes);
    const key = objectKey(session.dataset, contentHash);

    await store.put(key, stripped.bytes, actual);
    const object = await this.media.register({
      contentHash,
      dataset: session.dataset,
      receivedHash,
      mimeType: actual,
      byteSize: stripped.bytes.length,
      receivedSize: received.length,
      storageRef: key,
      metadataStripped: true,
      firstSeenBy: session.started_by,
    });

    await this.media.complete(session.id, contentHash);
    await this.sweep(session.id, chunks.map((chunk) => chunk.storage_ref));

    await this.audit.record({
      action: 'media.write',
      outcome: 'allowed',
      dataset: session.dataset as Dataset,
      actor: context.requester,
      reason: 'object_stored',
      correlationId: context.correlation,
      detail: {
        content_hash: contentHash,
        bytes: stripped.bytes.length,
        metadata_removed: stripped.removed,
      },
    });

    return {
      session: { ...session, state: 'complete', content_hash: contentHash },
      object,
    };
  }

  private async fail(
    session: UploadSessionRow,
    reason: string,
    context: UploadContext,
  ): Promise<void> {
    const chunks = await this.media.chunks(session.id);
    await this.media.reject(session.id, reason);
    await this.sweep(session.id, chunks.map((chunk) => chunk.storage_ref));
    await this.audit.record({
      action: 'media.refused',
      outcome: 'denied',
      dataset: session.dataset as Dataset,
      actor: context.requester,
      reason,
      correlationId: context.correlation,
      detail: { session: session.id },
    });
  }

  private async sweep(sessionId: string, keys: readonly string[]): Promise<void> {
    const store = this.require();
    for (const key of keys) {
      await store.delete(key);
    }
    await this.media.discardChunks(sessionId);
  }

  /* ── releasing bytes ───────────────────────────────────────────────────── */

  /**
   * A short-lived download URL, issued only if the caller may read a record
   * that cites the object.
   *
   * The consent check is the same one the record read goes through — not a
   * reimplementation of it, which would drift. If no cited record is readable,
   * the answer is null, and the controller turns that into a 404: a 403 would
   * confirm the object exists to somebody who has no business knowing.
   */
  async release(
    contentHash: string,
    reader: Reader,
  ): Promise<{ url: string; expires_in: number } | null> {
    const store = this.require();
    const dataset = reader.dataset ?? 'live';

    const object = await this.media.object(contentHash, dataset);
    if (object === null) return null;

    const citations = await this.media.citedBy(contentHash, dataset);
    let permitted: { record: string; subjects: string[]; type: string } | null = null;
    for (const citation of citations) {
      const view =
        citation.record_class === 'inference'
          ? await this.reads.getInference(citation.record_id, reader).catch(() => null)
          : await this.reads.get(citation.record_id, reader).catch(() => null);
      if (view !== null) {
        permitted = {
          record: citation.record_id,
          subjects: subjectsOf(view.record),
          type: String((view.record as Record<string, unknown>)['type'] ?? 'unknown'),
        };
        break;
      }
    }
    if (permitted === null) return null;

    const url = await store.downloadUrl(object.storage_ref);

    // Filed with the citing record and its subjects, not just the hash. A
    // disclosure the subject cannot find in their own s.24(1)(c) answer is a
    // disclosure that did not happen as far as they can tell, and photographs
    // are the entries they would most want to find.
    await this.audit.record({
      action: 'media.read',
      outcome: 'allowed',
      dataset: dataset as Dataset,
      actor: reader.requester,
      purpose: reader.purpose ?? null,
      subjects: permitted.subjects,
      records: [permitted.record],
      recordTypes: [permitted.type],
      correlationId: reader.correlationId ?? null,
      detail: { access: 'media', content_hash: contentHash },
    });

    return { url, expires_in: DOWNLOAD_URL_TTL_SECONDS };
  }

  private require(): ObjectStore {
    if (this.store === null) throw new MediaUnavailable();
    return this.store;
  }
}
