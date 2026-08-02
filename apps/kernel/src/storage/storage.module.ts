import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Pool } from 'pg';

import { loadConfig } from '../config.js';
import { createPool, KERNEL_POOL } from './pool.js';

@Global()
@Module({
  providers: [
    {
      provide: KERNEL_POOL,
      useFactory: () => createPool(loadConfig().DATABASE_URL),
    },
  ],
  exports: [KERNEL_POOL],
})
export class StorageModule implements OnApplicationShutdown {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
