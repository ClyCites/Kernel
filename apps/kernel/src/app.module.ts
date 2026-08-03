import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import compression from 'compression';

import { ApiModule } from './api/api.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ConsentModule } from './consent/consent.module.js';
import { RecordsModule } from './records/records.module.js';
import { RegistryModule } from './registry/registry.module.js';
import { StorageModule } from './storage/storage.module.js';

/**
 * `compression`'s 1KB default is tuned for broadband. A sync page over 2G is
 * worth compressing well below that, and the CPU cost of gzipping a few hundred
 * bytes is irrelevant next to the radio time it saves.
 */
const COMPRESSION_THRESHOLD_BYTES = 256;

@Module({
  imports: [
    StorageModule,
    AuditModule,
    ConsentModule,
    RegistryModule,
    RecordsModule,
    ApiModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied here rather than in main.ts so tests exercise the same pipeline.
    consumer
      .apply(compression({ threshold: COMPRESSION_THRESHOLD_BYTES }))
      .forRoutes('*path');
  }
}
