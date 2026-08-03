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
 * not select from the table either. It calls one security-definer function
 * (0023) that is scoped to a single subject and to disclosures that were
 * allowed, which is the whole of what s.24(1)(c) requires and none of what
 * reading the log would give away.
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
