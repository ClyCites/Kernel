import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { AuditService } from '../audit/audit.service.js';
import type { Dataset } from '../records/record.js';
import type { LawfulBasis } from '../records/lawful-basis.js';
import {
  RetentionNoticeRepository,
  type NoticeChannel,
  type RetentionNoticeRow,
} from './retention-notice.repository.js';

export interface GiveNotice {
  party: string;
  noticeText: string;
  periodStated: string;
  lawfulBasis: LawfulBasis;
  purposes: string[];
  language: string;
  givenVia: NoticeChannel;
  givenBy: string | null;
  givenAt: string;
  dataset: Dataset;
  correlationId?: string | null | undefined;
}

/**
 * DPPA s.13(1)(i) — the retention notice given to a subject at enrolment,
 * recorded as it was given.
 *
 * This service records and reads. It does **not** act on `period_stated`, and
 * nothing in the kernel does. The period a record may lawfully be held for is
 * open decision D3, unresolved and blocked on counsel, and a job that deleted
 * records on a period we cannot yet justify would be the one irreversible
 * mistake available here. Recording what the subject was told is both honest
 * today and a precondition of any expiry job that is ever written: such a job
 * would have to know what each subject was promised, and that cannot be
 * reconstructed after the fact.
 */
@Injectable()
export class RetentionNoticeService {
  constructor(
    @Inject(RetentionNoticeRepository)
    private readonly repository: RetentionNoticeRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async give(notice: GiveNotice): Promise<RetentionNoticeRow> {
    const row = await this.repository.insert({
      id: uuidv7(),
      party: notice.party,
      noticeText: notice.noticeText,
      periodStated: notice.periodStated,
      lawfulBasis: notice.lawfulBasis,
      purposes: notice.purposes,
      language: notice.language,
      givenVia: notice.givenVia,
      givenBy: notice.givenBy,
      givenAt: notice.givenAt,
      dataset: notice.dataset,
    });

    await this.audit.record({
      action: 'record.write',
      outcome: 'allowed',
      dataset: notice.dataset,
      reason: 'retention_notice_given',
      actor: notice.givenBy ?? notice.party,
      subjects: [notice.party],
      records: [row.id],
      recordTypes: ['retention_notice'],
      detail: {
        given_via: notice.givenVia,
        language: notice.language,
        lawful_basis: notice.lawfulBasis,
      },
      correlationId: notice.correlationId ?? null,
    });

    return row;
  }

  /** Every notice this party was given, most recent first. */
  async history(party: string, dataset: Dataset): Promise<RetentionNoticeRow[]> {
    return this.repository.byParty(party, dataset);
  }

  /**
   * The notice that governed at a moment — the point of the whole table. A
   * farmer enrolled in March was told something; a policy changed in June does
   * not retroactively become what they were told.
   */
  async inForce(
    party: string,
    at: string,
    dataset: Dataset,
  ): Promise<RetentionNoticeRow | null> {
    return this.repository.asAt(party, at, dataset);
  }
}
