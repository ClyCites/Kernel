import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { RecordsModule } from '../records/records.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { CorrelationMiddleware } from './correlation.middleware.js';
import { ConsentController } from './consent.controller.js';
import { ObjectionController } from './objection.controller.js';
import { SubjectAccessController } from './subject-access.controller.js';
import { OperationsController } from './operations.controller.js';
import { PartiesController } from './parties.controller.js';
import { ProblemFilter } from './problem.filter.js';
import { RateLimitMiddleware } from './rate-limit.middleware.js';
import { RegistryCacheInterceptor } from './registry-cache.interceptor.js';
import { RecordsController } from './records.controller.js';
import { RegistryController } from './registry.controller.js';
import { SyncController } from './sync.controller.js';

/**
 * The public API. Brief §2: no application ever reaches past this boundary —
 * there is no direct database access for anyone but the kernel itself.
 */
@Module({
  imports: [RecordsModule, SyncModule, IdentityModule],
  controllers: [
    RecordsController,
    RegistryController,
    SyncController,
    PartiesController,
    ConsentController,
    ObjectionController,
    SubjectAccessController,
    OperationsController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    RegistryCacheInterceptor,
  ],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
    // Only the registry. Everywhere else a caller has a verified subject, so
    // abuse has a name attached and is an access-control question.
    consumer.apply(RateLimitMiddleware).forRoutes('v1/registry/*path');
  }
}
