import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { KERNEL_POOL } from '../storage/pool.js';
import { boundedIds, type AuditEntry } from './audit.entry.js';

/**
 * The write side of the audit log, and the only one in this process.
 *
 * There is no read method here and there must not be one. `kernel_app` holds
 * INSERT and nothing else (0017), so a `select` added to this file would fail
 * at runtime rather than compile time — which is the wrong place to find out.
 * Reading the access log is a privileged operator path, not an application
 * capability: an application that can read who has been looking at whom hands
 * that answer to anyone who compromises it.
 *
 * The single exception is `disclosure.repository.ts`, which answers s.24(1)(c)
 * through a security-definer function scoped to one subject. It still does not
 * select from this table.
 *
 * Note the absence of `returning`. The id is generated here precisely because
 * the insert cannot read back what the database assigned.
 */
@Injectable()
export class AuditRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  /** Returns the row as written, so the shipper does not have to read it back. */
  async append(entry: AuditEntry): Promise<ShippedEntry> {
    const row: ShippedEntry = {
      id: uuidv7(),
      occurred_at: new Date().toISOString(),
      action: entry.action,
      outcome: entry.outcome,
      dataset: entry.dataset,
      reason: entry.reason ?? null,
      actor: entry.actor ?? null,
      client_id: entry.clientId ?? null,
      acting_for: entry.actingFor ?? null,
      purpose: entry.purpose ?? null,
      subjects: boundedIds(entry.subjects),
      records: boundedIds(entry.records),
      record_types: [...new Set(entry.recordTypes ?? [])],
      detail: entry.detail ?? null,
      correlation_id: entry.correlationId ?? null,
    };

    await this.pool.query(
      `insert into audit.entry (
         id, occurred_at, action, outcome, dataset, reason, actor, client_id,
         acting_for, purpose, subjects, records, record_types, detail, correlation_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        row.id,
        row.occurred_at,
        row.action,
        row.outcome,
        row.dataset,
        row.reason,
        row.actor,
        row.client_id,
        row.acting_for,
        row.purpose,
        row.subjects,
        row.records,
        row.record_types,
        row.detail === null ? null : JSON.stringify(row.detail),
        row.correlation_id,
      ],
    );

    return row;
  }
}

/** Exactly what goes off-box. Same shape as the row, so the two cannot drift. */
export interface ShippedEntry {
  id: string;
  occurred_at: string;
  action: string;
  outcome: string;
  dataset: string;
  reason: string | null;
  actor: string | null;
  client_id: string | null;
  acting_for: string | null;
  purpose: string | null;
  subjects: string[];
  records: string[];
  record_types: string[];
  detail: Record<string, string | number | boolean | null> | null;
  correlation_id: string | null;
}
