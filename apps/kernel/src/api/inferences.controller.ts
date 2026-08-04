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

import { InferenceService } from '../inference/inference.service.js';
import { VERDICTS } from '../inference/inference.repository.js';
import { ReadService } from '../records/read.service.js';
import { verifiedSubject } from './subject.js';
import { correlationOf } from './correlation.middleware.js';
import { requestedDataset, declaredLawfulBasis } from './dataset.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

const Id = z.uuid();

const NewValidation = z.object({
  observation: z.uuid(),
  verdict: z.enum(VERDICTS),
  note: z.string().max(500).nullable().optional(),
});

/**
 * The inference write path, on its own controller and its own route prefix.
 *
 * `POST /v1/records` cannot reach here and never will: it pins
 * `record_class: 'observation'`, which is what stops a model output arriving
 * on the fact path by claiming to be one. A caller writing a prediction has to
 * say so in the URL.
 */
@Controller('v1/inferences')
export class InferencesController {
  constructor(
    @Inject(InferenceService) private readonly inferences: InferenceService,
    @Inject(ReadService) private readonly read: ReadService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const result = await this.inferences.append(body, {
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      lawfulBasis: declaredLawfulBasis(request),
      correlationId: correlationOf(request),
    });

    response.status(result.replayed ? 200 : 201);
    response.setHeader('Location', `/v1/inferences/${result.record.id}`);

    return this.read.getInference(result.record.id, {
      requester: result.record.asserted_by,
      dataset: result.record.dataset,
      correlationId: correlationOf(request),
    });
  }

  /**
   * Link the observation that later settled a prediction.
   *
   * A separate route from the write, because the two happen months apart. The
   * linkage is the evaluation dataset and it cannot be reconstructed
   * afterwards: once nobody remembers which August delivery corresponded to
   * which March forecast, the model can never be scored honestly again.
   */
  @Post(':id/validations')
  async validate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const parsed = NewValidation.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    }

    const linkedBy = verifiedSubject(request);
    if (linkedBy === null) {
      throw new BadRequestException('a validation must name who linked it');
    }

    const dataset = requestedDataset(request, this.config.SEED_INGEST_ENABLED);
    const inference = this.identifier(id);

    // Read first, through the guard, so a caller cannot use this route to
    // discover that an inference exists by watching which linkage attempts
    // fail on the foreign key and which fail on consent.
    const found = await this.read.getInference(inference, {
      requester: linkedBy,
      dataset,
      correlationId: correlationOf(request),
    });
    if (found === null) throw new NotFoundException(`no inference ${id}`);

    return this.inferences.validate({
      inference,
      observation: parsed.data.observation,
      verdict: parsed.data.verdict,
      note: parsed.data.note ?? null,
      linkedBy,
      dataset,
      correlationId: correlationOf(request),
    });
  }

  @Get(':id/validations')
  async validations(
    @Param('id') id: string,
    @Req() request: Request,
    @Query() _query: unknown,
  ): Promise<unknown> {
    const dataset = requestedDataset(request, this.config.SEED_INGEST_ENABLED);
    const inference = this.identifier(id);

    const found = await this.read.getInference(inference, {
      requester: verifiedSubject(request),
      dataset,
      correlationId: correlationOf(request),
    });
    if (found === null) throw new NotFoundException(`no inference ${id}`);

    return { validations: found.validation ?? [] };
  }

  private identifier(value: string): string {
    const parsed = Id.safeParse(value);
    if (!parsed.success) {
      throw new NotFoundException(`${value} is not a record id`);
    }
    return parsed.data;
  }
}
