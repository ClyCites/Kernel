import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { CONSENT_PURPOSES } from '../consent/consent.service.js';
import { IngestService } from '../records/ingest.service.js';
import {
  MAX_PAGE_SIZE,
  ReadService,
  type Reader,
} from '../records/read.service.js';
import { verifiedSubject } from './subject.js';
import { requestedDataset } from './dataset.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

/**
 * Query parameters are the kernel's own surface, not record contents, so they
 * are parsed here. Record contents are never validated outside
 * `@clycites/schema` (brief §7).
 */
const ListQuery = z.object({
  type: z.string().optional(),
  asserted_by: z.uuid().optional(),
  subject: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().optional(),
  purpose: z.enum(CONSENT_PURPOSES).optional(),
});

const Id = z.uuid();

@Controller('v1')
export class RecordsController {
  constructor(
    @Inject(IngestService) private readonly ingest: IngestService,
    @Inject(ReadService) private readonly read: ReadService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Post('records')
  async submit(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const result = await this.ingest.ingest(body, {
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
    });

    response.status(result.replayed ? 200 : 201);
    response.setHeader('Location', `/v1/records/${result.record.id}`);

    // Echoing the record back is a read and goes through the same guard. The
    // requester is the record's own asserter, taken from the stored record
    // rather than from the request — and so is the corpus, so a seed write
    // reads back without the header having to be trusted twice.
    return this.read.get(result.record.id, {
      requester: result.record.asserted_by,
      dataset: result.record.dataset,
    });
  }

  @Get('records')
  async list(
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    }

    return this.read.list(
      {
        type: parsed.data.type,
        assertedBy: parsed.data.asserted_by,
        subject: parsed.data.subject,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      },
      this.reader(request, parsed.data.purpose),
    );
  }

  @Get('records/:id')
  async get(@Param('id') id: string, @Req() request: Request): Promise<unknown> {
    const view = await this.read.get(this.id(id), this.reader(request));
    if (view === null) throw new NotFoundException(`no record ${id}`);
    return view;
  }

  @Get('records/:id/chain')
  async chain(
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<unknown> {
    const records = await this.read.chain(this.id(id), this.reader(request));
    if (records.length === 0) throw new NotFoundException(`no record ${id}`);
    return { records };
  }

  @Get('inferences/:id')
  async inference(
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<unknown> {
    const view = await this.read.getInference(
      this.id(id),
      this.reader(request),
    );
    if (view === null) throw new NotFoundException(`no inference ${id}`);
    return view;
  }

  private reader(
    request: Request,
    purpose?: (typeof CONSENT_PURPOSES)[number] | undefined,
  ): Reader {
    return {
      requester: verifiedSubject(request),
      purpose: purpose ?? null,
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
    };
  }

  private id(value: string): string {
    const parsed = Id.safeParse(value);
    if (!parsed.success) throw new NotFoundException(`${value} is not a record id`);
    return parsed.data;
  }
}
