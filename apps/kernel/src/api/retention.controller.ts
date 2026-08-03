import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { RetentionNoticeService } from '../consent/retention-notice.service.js';
import { NOTICE_CHANNELS } from '../consent/retention-notice.repository.js';
import { LAWFUL_BASES } from '../records/lawful-basis.js';
import { correlationOf } from './correlation.middleware.js';
import { requestedDataset } from './dataset.js';
import { verifiedSubject } from './subject.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

/**
 * DPPA s.13(1)(i) — the retention notice given at enrolment.
 *
 * Notices are given *by* the collector *to* the subject, so unlike a consent
 * grant the writer is not the subject. Both sides can read: the subject
 * because it is their notice, the collector because being able to show what
 * was said is the entire point of recording it.
 *
 * There is no PUT and no DELETE. A changed policy is a new notice, given
 * again, and the earlier one still governs the period before it.
 */

const NewNotice = z.object({
  party: z.uuid(),
  notice_text: z.string().min(1).max(20_000),
  period_stated: z.string().min(1).max(1_000),
  lawful_basis: z.enum(LAWFUL_BASES),
  purposes: z.array(z.string().min(1)).min(1).max(16),
  language: z.string().min(2).max(64),
  given_via: z.enum(NOTICE_CHANNELS),
  given_at: z.iso.datetime({ offset: true }),
});

const HistoryQuery = z.object({
  party: z.uuid(),
  /** Optional. Returns the single notice in force at that moment. */
  as_at: z.iso.datetime({ offset: true }).optional(),
});

@Controller('v1/retention')
export class RetentionController {
  constructor(
    @Inject(RetentionNoticeService)
    private readonly notices: RetentionNoticeService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Post('notices')
  async give(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    const caller = this.caller(request);
    const parsed = NewNotice.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    }

    // `given_by` is the verified caller, never a field in the body. A notice
    // that can name somebody else as its giver is a notice that can be
    // fabricated against them.
    return this.notices.give({
      party: parsed.data.party,
      noticeText: parsed.data.notice_text,
      periodStated: parsed.data.period_stated,
      lawfulBasis: parsed.data.lawful_basis,
      purposes: parsed.data.purposes,
      language: parsed.data.language,
      givenVia: parsed.data.given_via,
      givenBy: caller,
      givenAt: parsed.data.given_at,
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationId: correlationOf(request),
    });
  }

  @Get('notices')
  async history(
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const caller = this.caller(request);
    const parsed = HistoryQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException('party is required');

    const dataset = requestedDataset(request, this.config.SEED_INGEST_ENABLED);

    if (parsed.data.as_at !== undefined) {
      const notice = await this.notices.inForce(
        parsed.data.party,
        parsed.data.as_at,
        dataset,
      );
      return { notices: this.readable(notice === null ? [] : [notice], caller) };
    }

    const held = await this.notices.history(parsed.data.party, dataset);
    return { notices: this.readable(held, caller) };
  }

  /**
   * The subject sees all of theirs; anyone else sees only what they gave. A
   * cooperative cannot use this to read what a rival told the same farmer.
   */
  private readable<T extends { party: string; given_by: string | null }>(
    notices: T[],
    caller: string,
  ): T[] {
    return notices.filter(
      (notice) => notice.party === caller || notice.given_by === caller,
    );
  }

  private caller(request: Request): string {
    const subject = verifiedSubject(request);
    if (subject === null) {
      throw new ForbiddenException('a retention notice needs a named party behind it');
    }
    return subject;
  }
}
