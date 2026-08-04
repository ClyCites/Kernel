import {
  Body,
  Controller,
  Get,
  Head,
  Headers,
  HttpCode,
  Inject,
  Options,
  Param,
  Patch,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { correlationOf } from './correlation.middleware.js';
import { requestedDataset } from './dataset.js';
import { verifiedSubject } from './subject.js';
import {
  ALLOWED_MIME,
  MAX_CHUNK_BYTES,
  MAX_OBJECT_BYTES,
  MediaRejected,
} from '../media/format.js';
import { MediaService, MediaUnavailable } from '../media/media.service.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

/**
 * Resumable upload, tus 1.0.0 core plus creation.
 *
 * tus rather than a bespoke scheme because the failure this addresses is not
 * hypothetical: a 4MB photograph over a metered rural link fails partway
 * through, repeatedly, and a client that cannot resume gives up. The record
 * then never syncs — and it fails *silently*, because from the field worker's
 * side the delivery was recorded. Every existing tus client already implements
 * the retry and offset logic correctly, which is the other half of the reason.
 *
 * The subset implemented is core (HEAD, PATCH) and creation (POST). No
 * concatenation, no expiration extension header, no termination: an upload
 * cannot be deleted by its creator, because a half-received file that was
 * refused for a hash mismatch is evidence about a client that should be
 * inspectable, not evidence a client can remove.
 */
const TUS_VERSION = '1.0.0';

@Controller('v1/media')
export class MediaController {
  constructor(
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Options()
  @HttpCode(204)
  options(@Res({ passthrough: true }) response: Response): void {
    // Discovery answers for the upload path, so it fails the same way the
    // upload path does. Advertising a maximum size and an accept list for a
    // kernel with no store would send a client up a hill to take a photograph
    // that could never have been accepted.
    this.available();
    response.setHeader('Tus-Resumable', TUS_VERSION);
    response.setHeader('Tus-Version', TUS_VERSION);
    response.setHeader('Tus-Extension', 'creation');
    response.setHeader('Tus-Max-Size', String(MAX_OBJECT_BYTES));
    // Not part of tus. Stated so a client can refuse a file locally instead of
    // discovering the allow-list by uploading twelve megabytes of it.
    response.setHeader('Clycites-Accept-Types', ALLOWED_MIME.join(','));
    response.setHeader('Clycites-Max-Chunk', String(MAX_CHUNK_BYTES));
  }

  /**
   * Create an upload. The client states length, type and the hash it believes
   * the file has; the kernel believes none of it until the bytes arrive.
   */
  @Post()
  @HttpCode(201)
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('upload-length') uploadLength: string | undefined,
    @Headers('upload-metadata') uploadMetadata: string | undefined,
  ): Promise<void> {
    this.available();
    const requester = this.owner(request);
    const metadata = decodeMetadata(uploadMetadata);

    const size = Number(uploadLength ?? '');
    if (!Number.isSafeInteger(size)) {
      throw new BadRequestException('Upload-Length must be an integer');
    }

    const hash = metadata['content_hash'] ?? '';
    const mime = metadata['mime_type'] ?? '';

    try {
      const session = await this.media.begin(
        { hash, mime, size },
        {
          requester,
          dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
          correlation: correlationOf(request),
        },
      );
      response.setHeader('Tus-Resumable', TUS_VERSION);
      response.setHeader('Location', `/v1/media/${session.id}`);
      response.setHeader('Upload-Offset', '0');
    } catch (error) {
      if (error instanceof MediaRejected) {
        throw new BadRequestException({ reason: error.reason, detail: error.message });
      }
      throw error;
    }
  }

  /**
   * Where the server thinks the upload got to. This is the resume: a client
   * that lost its connection asks here and continues from the answer, rather
   * than from zero.
   */
  @Head(':id')
  @HttpCode(200)
  async offset(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ): Promise<void> {
    this.available();
    const requester = this.owner(request);
    const session = await this.media.session(
      id,
      requestedDataset(request, this.config.SEED_INGEST_ENABLED),
    );

    // A session that is not yours is a session that does not exist. Confirming
    // it would leak that somebody uploaded something.
    if (session === null || session.started_by !== requester) {
      throw new NotFoundException();
    }

    response.setHeader('Tus-Resumable', TUS_VERSION);
    response.setHeader('Upload-Offset', String(session.received_size));
    response.setHeader('Upload-Length', String(session.declared_size));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Clycites-Upload-State', session.state);
    if (session.rejection !== null) {
      response.setHeader('Clycites-Upload-Rejection', session.rejection);
    }
    if (session.content_hash !== null) {
      response.setHeader('Clycites-Content-Hash', session.content_hash);
    }
  }

  /**
   * Bytes, at an offset.
   *
   * The offset is checked against the server's own count rather than trusted.
   * Two clients resuming the same session, or one client retrying a request
   * that in fact succeeded, must not both advance it — the assembled file
   * would contain a gap and still hash to something.
   */
  @Patch(':id')
  @HttpCode(204)
  async append(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Headers('upload-offset') uploadOffset: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    this.available();

    if (contentType !== 'application/offset+octet-stream') {
      throw new BadRequestException(
        'Content-Type must be application/offset+octet-stream',
      );
    }
    const offset = Number(uploadOffset ?? '');
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BadRequestException('Upload-Offset must be a non-negative integer');
    }
    if (!Buffer.isBuffer(body)) {
      throw new BadRequestException('a raw body is required');
    }

    const outcome = await this.media.receive(id, offset, body, {
      requester: this.owner(request),
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlation: correlationOf(request),
    });

    if (outcome === null) {
      // tus says 409 for an offset that does not match. It also covers a
      // session that is not open, or is not the caller's — deliberately the
      // same answer, so probing cannot distinguish them.
      throw new ConflictException({ reason: 'offset_conflict' });
    }

    response.setHeader('Tus-Resumable', TUS_VERSION);
    response.setHeader('Upload-Offset', String(outcome.session.received_size));
    response.setHeader('Clycites-Upload-State', outcome.session.state);
    if (outcome.session.rejection !== null) {
      response.setHeader('Clycites-Upload-Rejection', outcome.session.rejection);
    }
    if (outcome.object !== null) {
      response.setHeader('Clycites-Content-Hash', outcome.object.content_hash);
      response.setHeader('Clycites-Metadata-Stripped', 'true');
    }
  }

  /**
   * A short-lived download url for stored bytes.
   *
   * The consent check runs first, against the records that cite the object.
   * There is no unauthenticated path to the bucket, so this endpoint is the
   * whole of the read side and the guard on it is the whole of the control.
   */
  @Get(':hash/url')
  async url(
    @Req() request: Request,
    @Param('hash') hash: string,
  ): Promise<{ url: string; expires_in: number }> {
    this.available();

    const released = await this.media.release(hash, {
      requester: verifiedSubject(request),
      purpose: request.query['purpose'] as never,
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationId: correlationOf(request),
    });

    // 404 and not 403, as everywhere else: a refusal that distinguishes
    // "exists but you may not" from "does not exist" is itself a disclosure.
    if (released === null) throw new NotFoundException();
    return released;
  }

  private available(): void {
    if (!this.media.configured) {
      throw new ServiceUnavailableException({
        reason: 'media_unconfigured',
        detail: 'no object store is configured for this kernel',
      });
    }
  }

  /**
   * An upload has an owner, always.
   *
   * Elsewhere in the API an unverified caller is allowed through and denied by
   * the consent guard, which is the right shape when the question is "may you
   * see this record". Here the question is "is this your upload", and a null
   * owner would make every anonymous session belong to every anonymous caller
   * — anyone could resume, and therefore finish, anyone else's file.
   */
  private owner(request: Request): string {
    const requester = verifiedSubject(request);
    if (requester === null) throw new NotFoundException();
    return requester;
  }
}

/**
 * `Upload-Metadata` is a comma-separated list of `key base64value` pairs.
 *
 * Decoded defensively: a malformed pair is skipped rather than throwing, and
 * values are length-capped, because this is attacker-controlled input arriving
 * before any authentication of the file itself.
 */
function decodeMetadata(header: string | undefined): Record<string, string> {
  const pairs: Record<string, string> = {};
  if (header === undefined) return pairs;

  for (const entry of header.split(',')) {
    const [key, value] = entry.trim().split(' ');
    if (key === undefined || key === '' || value === undefined) continue;
    if (key.length > 64 || value.length > 512) continue;
    try {
      pairs[key] = Buffer.from(value, 'base64').toString('utf8');
    } catch {
      continue;
    }
  }
  return pairs;
}

export { MediaUnavailable };
