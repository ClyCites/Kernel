import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import type { Dataset } from '../records/record.js';
import type { LawfulBasis } from '../records/lawful-basis.js';

/**
 * How the notice reached the subject. Reading it aloud is the common case in
 * the field and is a perfectly good answer; what is not acceptable is a notice
 * nobody can say was delivered at all.
 */
export const NOTICE_CHANNELS = [
  'in_person_reading',
  'in_person_signature',
  'ussd_confirmation',
  'sms',
  'printed_handout',
  'witnessed',
] as const;

export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];

export interface RetentionNoticeRow {
  id: string;
  party: string;
  notice_text: string;
  period_stated: string;
  lawful_basis: LawfulBasis;
  purposes: string[];
  language: string;
  given_via: NoticeChannel;
  given_by: string | null;
  given_at: string;
  dataset: Dataset;
}

export interface NewRetentionNotice {
  id: string;
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
}

/**
 * Timestamps come back as text. A field that is `string` at compile time and
 * `Date` at runtime is how a comparison silently becomes `NaN`.
 */
const COLUMNS = `id, party, notice_text, period_stated, lawful_basis, purposes,
  language, given_via, given_by,
  to_json(given_at) #>> '{}' as given_at, dataset`;

@Injectable()
export class RetentionNoticeRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  async insert(notice: NewRetentionNotice): Promise<RetentionNoticeRow> {
    const { rows } = await this.pool.query<RetentionNoticeRow>(
      `insert into kernel.retention_notice
         (id, party, notice_text, period_stated, lawful_basis, purposes,
          language, given_via, given_by, given_at, dataset)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning ${COLUMNS}`,
      [
        notice.id,
        notice.party,
        notice.noticeText,
        notice.periodStated,
        notice.lawfulBasis,
        notice.purposes,
        notice.language,
        notice.givenVia,
        notice.givenBy,
        notice.givenAt,
        notice.dataset,
      ],
    );

    const row = rows[0];
    if (row === undefined) throw new Error('retention notice insert returned no row');
    return row;
  }

  /** Every notice this party was given, most recent first. */
  async byParty(party: string, dataset: Dataset): Promise<RetentionNoticeRow[]> {
    const { rows } = await this.pool.query<RetentionNoticeRow>(
      `select ${COLUMNS} from kernel.retention_notice
        where party = $1 and dataset = $2
        order by given_at desc, id desc`,
      [party, dataset],
    );
    return rows;
  }

  /**
   * The notice in force at a moment. This, not the latest one, is the answer
   * to "what was this farmer told" about anything that happened back then.
   */
  async asAt(
    party: string,
    at: string,
    dataset: Dataset,
  ): Promise<RetentionNoticeRow | null> {
    const { rows } = await this.pool.query<RetentionNoticeRow>(
      `select ${COLUMNS} from kernel.retention_notice
        where party = $1 and dataset = $2 and given_at <= $3
        order by given_at desc, id desc
        limit 1`,
      [party, dataset, at],
    );
    return rows[0] ?? null;
  }
}
