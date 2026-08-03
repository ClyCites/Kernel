import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import {
  ObjectionRefused,
  ObjectionService,
  OBJECTION_CHANNELS,
  WITHDRAWAL_CHANNELS,
} from '../consent/objection.service.js';
import { correlationOf } from './correlation.middleware.js';
import { requestedDataset } from './dataset.js';
import { verifiedSubject } from './subject.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

/**
 * Objection under s.7(3).
 *
 * The asymmetry is the shape of this controller: POST accepts `on_behalf_of`
 * and a delegation, DELETE does not accept either. Lodging protects the
 * subject and may be delegated; withdrawing removes the protection and may
 * not. See docs/decisions/0030-objection.md.
 */

const NewObjection = z.object({
  on_behalf_of: z.uuid().optional(),
  delegation: z.uuid().optional(),
  scope: z.array(z.string().min(1)).min(1).max(32).nullable().optional(),
  lodged_via: z.enum(OBJECTION_CHANNELS),
  evidence: z.array(z.unknown()).max(10).optional(),
});

const Withdrawal = z.object({
  withdrawn_via: z.enum(WITHDRAWAL_CHANNELS),
  reason: z.string().max(500).nullable().optional(),
});

@Controller('v1/objections')
export class ObjectionController {
  constructor(
    @Inject(ObjectionService) private readonly objections: ObjectionService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Get()
  async standing(@Req() request: Request): Promise<unknown> {
    const caller = this.caller(request);
    return {
      objections: await this.objections.standing(
        caller,
        requestedDataset(request, this.config.SEED_INGEST_ENABLED),
        correlationOf(request),
      ),
    };
  }

  @Post()
  async lodge(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    const caller = this.caller(request);
    const parsed = NewObjection.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    }

    try {
      return await this.objections.lodge({
        subject: parsed.data.on_behalf_of ?? caller,
        scope: parsed.data.scope ?? null,
        lodgedVia: parsed.data.lodged_via,
        lodgedBy: caller,
        delegation: parsed.data.delegation ?? null,
        evidence: parsed.data.evidence ?? [],
        dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
        correlationId: correlationOf(request),
      });
    } catch (error) {
      if (error instanceof ObjectionRefused) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** Re-consenting. Only the subject, and never under a delegation. */
  @Delete(':id')
  async withdraw(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const caller = this.caller(request);
    const parsed = Withdrawal.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        'withdrawing an objection requires withdrawn_via of in_person or written',
      );
    }

    const withdrawn = await this.objections.withdraw(
      id,
      caller,
      parsed.data.withdrawn_via,
      parsed.data.reason ?? null,
      requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationOf(request),
    );
    if (withdrawn === null) throw new NotFoundException(`no objection ${id}`);
    return withdrawn;
  }

  private caller(request: Request): string {
    const subject = verifiedSubject(request);
    if (subject === null) {
      throw new ForbiddenException('an objection needs a verified subject');
    }
    return subject;
  }
}
