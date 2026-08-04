import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { AnchorService, type AnchorProof } from '../anchoring/anchor.service.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import { requestedDataset } from './dataset.js';
import { verifiedSubject } from './subject.js';
import { correlationOf } from './correlation.middleware.js';

interface PublishedRoot {
  batch_date: string;
  merkle_root: string;
  record_count: number;
}

/**
 * The point of anchoring, from outside.
 *
 * Everything here exists so that somebody who does not trust ClyCites can
 * check a record anyway. If these two routes were removed, the daily message
 * would still go out and would still mean nothing to anyone.
 */
@Controller('v1/anchors')
export class AnchorsController {
  constructor(
    @Inject(AnchorService) private readonly anchors: AnchorService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  /**
   * Every published root.
   *
   * Unauthenticated, like the registry and for the same reason: a root you
   * need our permission to see is a root you are trusting us for.
   */
  @Get('roots')
  async roots(): Promise<{ roots: PublishedRoot[] }> {
    return { roots: await this.anchors.roots() };
  }

  /**
   * One record's proof.
   *
   * Behind the ordinary read check — see the note on `AnchorService.proof`.
   * 404 covers both "no such record" and "not anchored yet", because telling
   * the two apart would confirm a record exists to somebody who may not read it.
   */
  @Get(':id/proof')
  async proof(@Req() request: Request, @Param('id') id: string): Promise<AnchorProof> {
    const proof = await this.anchors.proof(id, {
      requester: verifiedSubject(request),
      purpose: request.query['purpose'] as never,
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationId: correlationOf(request),
    });

    if (proof === null) throw new NotFoundException();
    return proof;
  }
}
