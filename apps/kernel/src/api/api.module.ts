import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { RecordsModule } from '../records/records.module.js';
import { InferenceModule } from '../inference/inference.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MediaModule } from '../media/media.module.js';
import { AnchoringModule } from '../anchoring/anchor.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { FieldModule } from '../field/field.module.js';
import { CorrelationMiddleware } from './correlation.middleware.js';
import { ConsentController } from './consent.controller.js';
import { ObjectionController } from './objection.controller.js';
import { SubjectAccessController } from './subject-access.controller.js';
import { OperationsController } from './operations.controller.js';
import { PartiesController } from './parties.controller.js';
import { ProblemFilter } from './problem.filter.js';
import {
  ClientRateLimitMiddleware,
  RateLimitMiddleware,
} from './rate-limit.middleware.js';
import { RegistryCacheInterceptor } from './registry-cache.interceptor.js';
import { RecordsController } from './records.controller.js';
import { ConfirmationsController } from './confirmations.controller.js';
import { PurposeHeaderMiddleware } from './purpose.middleware.js';
import { InferencesController } from './inferences.controller.js';
import { MediaController } from './media.controller.js';
import { AnchorsController } from './anchors.controller.js';
import { RegistryController } from './registry.controller.js';
import { RetentionController } from './retention.controller.js';
import { SyncController } from './sync.controller.js';
import { ClientsController } from './clients.controller.js';
import { FieldController } from './field.controller.js';

/**
 * The public API. Brief §2: no application ever reaches past this boundary —
 * there is no direct database access for anyone but the kernel itself.
 */
@Module({
  imports: [
    RecordsModule,
    InferenceModule,
    MediaModule,
    AnchoringModule,
    SyncModule,
    IdentityModule,
    FieldModule,
  ],
  controllers: [
    RecordsController,
    ConfirmationsController,
    InferencesController,
    MediaController,
    AnchorsController,
    RegistryController,
    SyncController,
    PartiesController,
    ConsentController,
    ObjectionController,
    RetentionController,
    SubjectAccessController,
    OperationsController,
    ClientsController,
    FieldController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    RegistryCacheInterceptor,
  ],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
    consumer.apply(PurposeHeaderMiddleware).forRoutes('*path');
    consumer.apply(RateLimitMiddleware).forRoutes('v1/registry/*path');
    consumer
      .apply(ClientRateLimitMiddleware)
      .exclude('v1/registry/*path')
      .forRoutes('*path');
  }
}
