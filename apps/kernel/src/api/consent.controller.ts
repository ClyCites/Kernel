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

import { ConsentGrantService } from '../consent/consent-grant.service.js';
import {
  CONSENT_CHANNELS,
  CONSENT_PURPOSES,
} from '../consent/consent.service.js';
import { correlationOf } from './correlation.middleware.js';
import { requestedDataset } from './dataset.js';
import { verifiedSubject } from './subject.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

/**
 * Consent grants. Only the subject writes here, and only the subject reads.
 *
 * A grantee that could create its own grant would have written itself a
 * permission slip; a grantee that could list a subject's grants could
 * enumerate everyone else that subject deals with.
 */

const NewGrant = z.object({
  grantee: z.uuid(),
  purpose: z.enum(CONSENT_PURPOSES),
  record_types: z.array(z.string().min(1)).min(1).max(32),
  expires_at: z.iso.datetime().nullable().optional(),
  granted_via: z.enum(CONSENT_CHANNELS),
  evidence: z.array(z.unknown()).max(10).optional(),
});

const Revocation = z.object({
  reason: z.string().max(500).nullable().optional(),
});

@Controller('v1/consent')
export class ConsentController {
  constructor(
    @Inject(ConsentGrantService) private readonly grants: ConsentGrantService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  /** What this subject has permitted. Part of their s.24 access answer. */
  @Get('grants')
  async held(@Req() request: Request): Promise<unknown> {
    const subject = this.subject(request);
    return {
      grants: await this.grants.held(
        subject,
        requestedDataset(request, this.config.SEED_INGEST_ENABLED),
        correlationOf(request),
      ),
    };
  }

  @Post('grants')
  async grant(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    const subject = this.subject(request);
    const parsed = NewGrant.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    }
    if (parsed.data.grantee === subject) {
      throw new BadRequestException('a party cannot grant consent to itself');
    }

    return this.grants.grant({
      subject,
      grantee: parsed.data.grantee,
      purpose: parsed.data.purpose,
      recordTypes: parsed.data.record_types,
      expiresAt: parsed.data.expires_at ?? null,
      grantedVia: parsed.data.granted_via,
      evidence: parsed.data.evidence ?? [],
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationId: correlationOf(request),
    });
  }

  /** s.10(4). The grant row is untouched; a revocation is inserted beside it. */
  @Delete('grants/:id')
  async revoke(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const subject = this.subject(request);
    const parsed = Revocation.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('invalid revocation');

    const revoked = await this.grants.revoke(
      id,
      subject,
      parsed.data.reason ?? null,
      requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationOf(request),
    );
    if (revoked === null) throw new NotFoundException(`no grant ${id}`);
    return revoked;
  }

  private subject(request: Request): string {
    const subject = verifiedSubject(request);
    if (subject === null) {
      throw new ForbiddenException('only the subject may manage their grants');
    }
    return subject;
  }
}
