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
import { requestedDataset, declaredLawfulBasis } from './dataset.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

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
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Post('devices')
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
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
    const outcomes = await this.sync.drain(
      Array.isArray(body) ? body : (body as { records?: unknown })?.records,
      {
        dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
        lawfulBasis: declaredLawfulBasis(request),
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
        requester: verifiedSubject(request),
        purpose: null,
        dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      },
    );
  }
}
