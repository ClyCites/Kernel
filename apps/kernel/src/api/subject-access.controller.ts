import { Controller, ForbiddenException, Get, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';

import { SubjectAccessService } from '../consent/subject-access.service.js';
import { correlationOf } from './correlation.middleware.js';
import { requestedDataset } from './dataset.js';
import { verifiedSubject } from './subject.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

/**
 * Subject access under s.24.
 *
 * There is no subject parameter and there must not be one. The answer is
 * assembled for the verified subject and nobody else, because a route that
 * took an id would be a route for enumerating everyone's records with one
 * compromised token.
 */
@Controller('v1/subject-access')
export class SubjectAccessController {
  constructor(
    @Inject(SubjectAccessService) private readonly access: SubjectAccessService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Get()
  async assemble(@Req() request: Request): Promise<unknown> {
    const caller = verifiedSubject(request);
    if (caller === null) {
      throw new ForbiddenException('subject access requires a verified subject');
    }

    return this.access.assemble(
      caller,
      requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationOf(request),
    );
  }
}
