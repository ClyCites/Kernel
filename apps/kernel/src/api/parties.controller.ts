import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { CONSENT_PURPOSES } from '../consent/consent.service.js';
import { LAWFUL_BASES } from '../records/lawful-basis.js';
import { PartyLinkService } from '../identity/party-link.service.js';
import { correlationOf } from './correlation.middleware.js';
import { requestedDataset } from './dataset.js';
import { verifiedSubject } from './subject.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

/**
 * Identity links. Work order M3, deferring open decision D2.
 *
 * The response shape is the decision. `identities` is a set and `collapsed` is
 * a literal `false` — there is no canonical id here and no route that will give
 * you one, because merging is not reversible and this kernel has not been told
 * by anyone in the field that merging is what cooperatives want.
 */

const Id = z.uuid();

const LinkQuery = z.object({
  purpose: z.enum(CONSENT_PURPOSES).optional(),
});

const EVIDENCE = [
  'national_id_match',
  'phone_match',
  'name_and_region_match',
  'declared_by_subject',
  'declared_by_organisation',
  'assumed',
] as const;

const NewLink = z.object({
  left_party: z.uuid(),
  right_party: z.uuid(),
  /** Never taken from the body: see `assertedBy` below. */
  confidence: z.number().gt(0).max(1),
  evidence: z.enum(EVIDENCE),
  evidence_note: z.string().max(500).nullable().optional(),
  lawful_basis: z.enum(LAWFUL_BASES),
});

const Retraction = z.object({ reason: z.string().min(1).max(500) });

@Controller('v1/parties')
export class PartiesController {
  constructor(
    @Inject(PartyLinkService) private readonly links: PartyLinkService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  /** Everything reachable from this party, and the links that got you there. */
  @Get(':id/links')
  async resolve(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const filter = parse(LinkQuery, query);
    return this.links.resolve(this.id(id), {
      requester: verifiedSubject(request),
      purpose: filter.purpose ?? null,
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationId: correlationOf(request),
    });
  }

  @Post('links')
  async assert(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    const link = parse(NewLink, body);
    // The asserter is the verified subject, never a body field. A caller who
    // can name who asserted a link can attribute their guess to somebody else.
    const assertedBy = verifiedSubject(request);
    if (assertedBy === null) {
      throw new BadRequestException('a verified subject must assert the link');
    }

    return this.links.assert({
      leftParty: link.left_party,
      rightParty: link.right_party,
      assertedBy,
      confidence: link.confidence,
      evidence: link.evidence,
      evidenceNote: link.evidence_note ?? null,
      lawfulBasis: link.lawful_basis,
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationId: correlationOf(request),
    });
  }

  /**
   * Withdraw a link. Nothing is deleted — the row keeps its retraction, which
   * is what makes the whole arrangement reversible rather than merely undone.
   */
  @Delete('links/:id')
  async retract(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const { reason } = parse(Retraction, body);
    const by = verifiedSubject(request);
    if (by === null) {
      throw new BadRequestException('a verified subject must retract the link');
    }

    const retracted = await this.links.retract(
      this.id(id),
      by,
      reason,
      correlationOf(request),
    );
    if (retracted === null) {
      throw new NotFoundException(`no live link ${id}`);
    }
    return retracted;
  }

  private id(value: string): string {
    const parsed = Id.safeParse(value);
    if (!parsed.success) throw new NotFoundException(`${value} is not a party id`);
    return parsed.data;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}
