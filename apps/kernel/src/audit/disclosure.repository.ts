import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import type { Dataset } from '../records/record.js';

/**
 * The read side of the audit log, and deliberately not in audit.repository.ts.
 *
 * That file holds the write path and says there must be no read method in it,
 * which remains true: `kernel_app` has INSERT on `audit.entry` and nothing
 * else, so a `select` added there would still fail at runtime. This file does
 * not select from the table either. It calls security-definer functions (0023,
 * 0024), each scoped to one subject or one record and to disclosures that were
 * allowed, which is the whole of what s.24(1)(c) and s.16(4) require and none
 * of what reading the log would give away.
 */
@Injectable()
export class DisclosureRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  async disclosuresTo(subject: string, dataset: Dataset): Promise<DisclosureRow[]> {
    const { rows } = await this.pool.query<{
      occurred_at: string;
      actor: string | null;
      purpose: string | null;
      access: string | null;
      record_types: string[];
      records: string[];
    }>(
      `select to_json(occurred_at) #>> '{}' as occurred_at,
              actor, purpose, access, record_types, records
         from audit.disclosures_to($1::uuid, $2::text)`,
      [subject, dataset],
    );

    return rows.map((row) => ({
      occurred_at: row.occurred_at,
      actor: row.actor,
      purpose: row.purpose,
      access: row.access,
      record_types: row.record_types ?? [],
      records: row.records ?? [],
    }));
  }

  /**
   * s.16(4). The third parties who received one record, for telling them it
   * has been corrected.
   *
   * `exclude` only ever narrows the answer, so passing it from the application
   * gives nothing away — and the parties who must not appear (the subject, the
   * asserter, whoever wrote the correction) are readable from the record but
   * not from the log.
   */
  async recipientsOf(
    record: string,
    dataset: Dataset,
    exclude: readonly string[],
  ): Promise<RecipientRow[]> {
    const { rows } = await this.pool.query<{
      recipient: string;
      first_seen: string;
      last_seen: string;
      disclosures: string;
    }>(
      `select recipient,
              to_json(first_seen) #>> '{}' as first_seen,
              to_json(last_seen) #>> '{}' as last_seen,
              disclosures
         from audit.recipients_of($1::uuid, $2::text, $3::uuid[])`,
      [record, dataset, [...new Set(exclude)]],
    );

    return rows.map((row) => ({
      recipient: row.recipient,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      disclosures: Number(row.disclosures),
    }));
  }
}

export interface DisclosureRow {
  occurred_at: string;
  /** The third party who read it. Null only where no verified claim reached us. */
  actor: string | null;
  purpose: string | null;
  /** Which permission was leaned on: a grant, membership, or being a party. */
  access: string | null;
  record_types: string[];
  records: string[];
}

export interface RecipientRow {
  recipient: string;
  first_seen: string;
  last_seen: string;
  /** How many times they read it. One notification is owed either way. */
  disclosures: number;
}
