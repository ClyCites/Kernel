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
import { correlationOf } from './correlation.middleware.js';
import { requestedDataset, declaredLawfulBasis } from './dataset.js';
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

/** Everything a third party needs to say about why it is reading. */
const PurposeQuery = z.object({ purpose: z.enum(CONSENT_PURPOSES).optional() });

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
      lawfulBasis: declaredLawfulBasis(request),
      correlationId: correlationOf(request),
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
      correlationId: correlationOf(request),
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

  // FINDING, fixed here: until P2 only the list endpoint took a purpose, so a
  // third party holding a valid grant could enumerate records but never
  // dereference one. Consent is purpose-bound, and a route with no way to
  // state a purpose is a route no grant can ever satisfy.
  @Get('records/:id')
  async get(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const view = await this.read.get(this.id(id), this.reader(request, this.purpose(query)));
    if (view === null) throw new NotFoundException(`no record ${id}`);
    return view;
  }

  @Get('records/:id/chain')
  async chain(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const records = await this.read.chain(
      this.id(id),
      this.reader(request, this.purpose(query)),
    );
    if (records.length === 0) throw new NotFoundException(`no record ${id}`);
    return { records };
  }

  @Get('inferences/:id')
  async inference(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const view = await this.read.getInference(
      this.id(id),
      this.reader(request, this.purpose(query)),
    );
    if (view === null) throw new NotFoundException(`no inference ${id}`);
    return view;
  }

  private purpose(query: unknown): (typeof CONSENT_PURPOSES)[number] | undefined {
    const parsed = PurposeQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException('unknown purpose');
    return parsed.data.purpose;
  }

  private reader(
    request: Request,
    purpose?: (typeof CONSENT_PURPOSES)[number] | undefined,
  ): Reader {
    return {
      requester: verifiedSubject(request),
      purpose: purpose ?? null,
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationId: correlationOf(request),
    };
  }

  private id(value: string): string {
    const parsed = Id.safeParse(value);
    if (!parsed.success) throw new NotFoundException(`${value} is not a record id`);
    return parsed.data;
  }
}
