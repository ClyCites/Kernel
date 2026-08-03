import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import type { Dataset } from '../records/record.js';

export type DeliveryChannel = 'sms' | 'ussd' | 'email' | 'webhook' | 'in_person';

export interface NewNotification {
  id: string;
  recordId: string;
  correctionId: string;
  recipient: string;
  dataset: Dataset;
}

export interface NotificationRow {
  id: string;
  record_id: string;
  correction_id: string;
  recipient: string;
  dataset: Dataset;
  raised_at: string;
  delivered_at: string | null;
  channel: DeliveryChannel | null;
}

export interface OutstandingCount {
  dataset: Dataset;
  notifications: number;
  /** Seconds since the oldest undischarged obligation was raised. */
  oldestSeconds: number;
}

const COLUMNS = `id, record_id, correction_id, recipient, dataset,
  to_json(raised_at) #>> '{}' as raised_at,
  to_json(delivered_at) #>> '{}' as delivered_at,
  channel`;

@Injectable()
export class DisclosureNotificationRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  /**
   * Idempotent on (record, correction, recipient). A correction that is
   * replayed — the same id arriving twice from a phone that never saw the ack
   * — must not owe the same party two notifications, and the unique index
   * rather than a prior read is what guarantees it.
   */
  async raise(notifications: readonly NewNotification[]): Promise<NotificationRow[]> {
    if (notifications.length === 0) return [];

    const { rows } = await this.pool.query<NotificationRow>(
      `insert into kernel.disclosure_notification
         (id, record_id, correction_id, recipient, dataset)
       select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[])
       on conflict (record_id, correction_id, recipient) do nothing
       returning ${COLUMNS}`,
      [
        notifications.map((n) => n.id),
        notifications.map((n) => n.recordId),
        notifications.map((n) => n.correctionId),
        notifications.map((n) => n.recipient),
        notifications.map((n) => n.dataset),
      ],
    );
    return rows;
  }

  async forRecord(record: string, dataset: Dataset): Promise<NotificationRow[]> {
    const { rows } = await this.pool.query<NotificationRow>(
      `select ${COLUMNS} from kernel.disclosure_notification
        where record_id = $1 and dataset = $2
        order by raised_at, recipient`,
      [record, dataset],
    );
    return rows;
  }

  /**
   * Write-once at the database (0024), so a second call returns null rather
   * than overwriting the first delivery.
   */
  async markDelivered(
    id: string,
    channel: DeliveryChannel,
    at: string,
  ): Promise<NotificationRow | null> {
    const { rows } = await this.pool.query<NotificationRow>(
      `update kernel.disclosure_notification
          set delivered_at = $3::timestamptz, channel = $2
        where id = $1 and delivered_at is null
        returning ${COLUMNS}`,
      [id, channel, at],
    );
    return rows[0] ?? null;
  }

  /**
   * The compliance signal. An outstanding queue is a statutory failure in
   * progress, so the age of the oldest one matters as much as the count.
   */
  async outstanding(): Promise<OutstandingCount[]> {
    const { rows } = await this.pool.query<{
      dataset: Dataset;
      notifications: string;
      oldest_seconds: string | null;
    }>(
      `select dataset, count(*) as notifications,
              extract(epoch from now() - min(raised_at)) as oldest_seconds
         from kernel.disclosure_notification
        where delivered_at is null
        group by dataset`,
    );

    return rows.map((row) => ({
      dataset: row.dataset,
      notifications: Number(row.notifications),
      oldestSeconds: Math.max(0, Math.floor(Number(row.oldest_seconds ?? 0))),
    }));
  }
}
