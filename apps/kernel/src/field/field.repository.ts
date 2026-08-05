import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';

export interface ConfirmationRequestRow {
  id: string;
  delivery: string;
  requested_by: string;
  client_id: string;
  dataset: 'live' | 'seed';
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  last_error: string | null;
  requested_at: string;
  updated_at: string;
}

export interface FieldEventRow {
  id: string;
  client_id: string;
  acting_for: string;
  event: string;
  choice: string;
  flow: string | null;
  step: string | null;
  recorded_at: string;
}

const REQUEST_COLUMNS = `
  id, delivery, requested_by, client_id, dataset, status, attempts, last_error,
  to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as requested_at,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at`;

@Injectable()
export class FieldRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  async queueConfirmation(input: {
    id: string;
    delivery: string;
    requestedBy: string;
    clientId: string;
    dataset: 'live' | 'seed';
  }): Promise<ConfirmationRequestRow> {
    const { rows } = await this.pool.query<ConfirmationRequestRow>(
      `insert into kernel.confirmation_request
         (id, delivery, requested_by, client_id, dataset)
       values ($1, $2, $3, $4, $5)
       on conflict (delivery, requested_by, dataset) do nothing
       returning ${REQUEST_COLUMNS}`,
      [input.id, input.delivery, input.requestedBy, input.clientId, input.dataset],
    );
    if (rows[0] !== undefined) return rows[0];

    const existing = await this.pool.query<ConfirmationRequestRow>(
      `select ${REQUEST_COLUMNS}
         from kernel.confirmation_request
        where delivery = $1 and requested_by = $2 and dataset = $3`,
      [input.delivery, input.requestedBy, input.dataset],
    );
    return existing.rows[0]!;
  }

  async confirmationRequests(
    requestedBy: string,
    dataset: 'live' | 'seed',
  ): Promise<ConfirmationRequestRow[]> {
    const { rows } = await this.pool.query<ConfirmationRequestRow>(
      `select ${REQUEST_COLUMNS}
         from kernel.confirmation_request
        where requested_by = $1 and dataset = $2
        order by requested_at desc, id desc
        limit 200`,
      [requestedBy, dataset],
    );
    return rows;
  }

  async recordEvent(input: Omit<FieldEventRow, 'recorded_at'>): Promise<FieldEventRow> {
    const { rows } = await this.pool.query<FieldEventRow>(
      `insert into kernel.field_event
         (id, client_id, acting_for, event, choice, flow, step)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, client_id, acting_for, event, choice, flow, step,
         to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as recorded_at`,
      [
        input.id,
        input.client_id,
        input.acting_for,
        input.event,
        input.choice,
        input.flow,
        input.step,
      ],
    );
    return rows[0]!;
  }

  async eventCounts(): Promise<Array<{ event: string; choice: string; flow: string; events: number }>> {
    const { rows } = await this.pool.query<{
      event: string;
      choice: string;
      flow: string;
      events: string;
    }>(
      `select event, choice, coalesce(flow, 'none') as flow, count(*)::text as events
         from kernel.field_event
        group by event, choice, flow
        order by event, choice, flow`,
    );
    return rows.map((row) => ({ ...row, events: Number(row.events) }));
  }
}