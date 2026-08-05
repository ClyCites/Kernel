import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { MAX_CHANGES, SyncService } from '../sync/sync.service.js';
import { verifiedSubject } from './subject.js';
import { correlationOf } from './correlation.middleware.js';
import { requestedDataset, declaredLawfulBasis } from './dataset.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import { ClientService } from '../identity/client.service.js';
import { actingFor, verifiedClient } from './subject.js';

const ChangesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CHANGES).optional(),
});

/**
 * Brief §4 invariant 5. Two endpoints for pushing an outbox and one for pulling
 * what was missed, all reachable only through the versioned public API.
 */
@Controller('v1')
export class SyncController {
  constructor(
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(ClientService) private readonly clients: ClientService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Post('devices')
  async register(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    await this.requester(request);
    const result = await this.sync.register(body);
    response.status(result.created ? 201 : 200);
    return result.device;
  }

  /**
   * Always 200. The status describes the batch, which was received; whether an
   * individual record was accepted is in the body, one entry per submission in
   * the order they were sent.
   */
  @Post('sync/outbox')
  @HttpCode(200)
  async drain(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    await this.requester(request);
    const outcomes = await this.sync.drain(
      Array.isArray(body) ? body : (body as { records?: unknown })?.records,
      {
        dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
        lawfulBasis: declaredLawfulBasis(request),
        correlationId: correlationOf(request),
      },
    );
    return { results: outcomes };
  }

  @Get('sync/changes')
  async changes(
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const parsed = ChangesQuery.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    }

    return this.sync.changes(
      {
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      },
      {
        requester: await this.requester(request),
        purpose: null,
        dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
        correlationId: correlationOf(request),
      },
    );
  }

  private async requester(request: Request): Promise<string | null> {
    const subject = verifiedSubject(request);
    const client = await this.clients.resolve(
      subject,
      verifiedClient(request),
      actingFor(request),
      'sync',
    );
    return client?.requester ?? subject;
  }
}
