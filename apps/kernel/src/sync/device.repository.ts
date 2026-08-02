import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';

export interface Device {
  device_id: string;
  registered_by: string;
  label: string;
  registered_at: string;
}

/**
 * The device registry. Append-only, like everything else the kernel writes.
 *
 * Registration is idempotent: the same device registering twice — which is the
 * normal case after a reinstall or a retried request on a bad connection — is
 * not an error. A device id claimed by a different party is refused, because
 * that is either a mistake or an attempt to inherit another device's history.
 */
@Injectable()
export class DeviceRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  /** Inserts if absent and returns the row that is now stored. */
  async registerIfAbsent(device: {
    device_id: string;
    registered_by: string;
    label: string;
  }): Promise<{ device: Device; created: boolean }> {
    const { rows } = await this.pool.query<Device & { created: boolean }>(
      `with attempted as (
         insert into kernel.device (device_id, registered_by, label)
              values ($1, $2, $3)
         on conflict (device_id) do nothing
           returning device_id, registered_by, label,
                     to_char(registered_at at time zone 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as registered_at,
                     true as created
       )
       select * from attempted
       union all
       select device_id, registered_by, label,
              to_char(registered_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as registered_at,
              false as created
         from kernel.device
        where device_id = $1
          and not exists (select 1 from attempted)`,
      [device.device_id, device.registered_by, device.label],
    );

    const row = rows[0];
    if (row === undefined) {
      throw new Error('device registration returned no row');
    }

    const { created, ...stored } = row;
    return { device: stored, created };
  }

  async find(deviceId: string): Promise<Device | null> {
    const { rows } = await this.pool.query<Device>(
      `select device_id, registered_by, label,
              to_char(registered_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as registered_at
         from kernel.device
        where device_id = $1`,
      [deviceId],
    );
    return rows[0] ?? null;
  }
}
