import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SCHEMA_VERSION } from '@clycites/schema';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';

@Controller('v1')
export class OperationsController {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  @Get('health')
  health(): { status: string; schema_version: string } {
    return { status: 'ok', schema_version: SCHEMA_VERSION };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; schema_version: string }> {
    try {
      await this.pool.query('select 1');
    } catch {
      throw new ServiceUnavailableException('the log is not reachable');
    }
    return { status: 'ready', schema_version: SCHEMA_VERSION };
  }
}
