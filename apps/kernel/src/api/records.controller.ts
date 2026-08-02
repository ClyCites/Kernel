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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { IngestService } from '../records/ingest.service.js';
import { MAX_PAGE_SIZE, ReadService } from '../records/read.service.js';

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
});

const Id = z.uuid();

@Controller('v1')
export class RecordsController {
  constructor(
    @Inject(IngestService) private readonly ingest: IngestService,
    @Inject(ReadService) private readonly read: ReadService,
  ) {}

  @Post('records')
  async submit(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const result = await this.ingest.ingest(body);

    response.status(result.replayed ? 200 : 201);
    response.setHeader('Location', `/v1/records/${result.record.id}`);

    return this.read.get(result.record.id);
  }

  @Get('records')
  async list(@Query() query: unknown): Promise<unknown> {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    }

    return this.read.list({
      type: parsed.data.type,
      assertedBy: parsed.data.asserted_by,
      subject: parsed.data.subject,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
  }

  @Get('records/:id')
  async get(@Param('id') id: string): Promise<unknown> {
    const view = await this.read.get(this.id(id));
    if (view === null) throw new NotFoundException(`no record ${id}`);
    return view;
  }

  @Get('records/:id/chain')
  async chain(@Param('id') id: string): Promise<unknown> {
    const records = await this.read.chain(this.id(id));
    if (records.length === 0) throw new NotFoundException(`no record ${id}`);
    return { records };
  }

  @Get('inferences/:id')
  async inference(@Param('id') id: string): Promise<unknown> {
    const view = await this.read.getInference(this.id(id));
    if (view === null) throw new NotFoundException(`no inference ${id}`);
    return view;
  }

  private id(value: string): string {
    const parsed = Id.safeParse(value);
    if (!parsed.success) throw new NotFoundException(`${value} is not a record id`);
    return parsed.data;
  }
}
