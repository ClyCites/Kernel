import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import compression from 'compression';
import { raw } from 'express';

import { ApiModule } from './api/api.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ConsentModule } from './consent/consent.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { MediaModule } from './media/media.module.js';
import { AnchoringModule } from './anchoring/anchor.module.js';
import { RecordsModule } from './records/records.module.js';
import { InferenceModule } from './inference/inference.module.js';
import { TrainingModule } from './training/training.module.js';
import { RegistryModule } from './registry/registry.module.js';
import { StorageModule } from './storage/storage.module.js';
import { MAX_CHUNK_BYTES } from './media/format.js';

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
    InferenceModule,
    MediaModule,
    AnchoringModule,
    TrainingModule,
    IdentityModule,
    ApiModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied here rather than in main.ts so tests exercise the same pipeline.
    consumer
      .apply(compression({ threshold: COMPRESSION_THRESHOLD_BYTES }))
      .forRoutes('*path');

    // tus sends chunks as `application/offset+octet-stream`, which the json
    // parser would leave as an empty object. The limit is the chunk ceiling
    // and not the object ceiling: a body larger than one chunk is refused by
    // express before it reaches a handler that would have to buffer it.
    consumer
      .apply(raw({ type: 'application/offset+octet-stream', limit: MAX_CHUNK_BYTES }))
      .forRoutes('v1/media/*path');
  }
}
