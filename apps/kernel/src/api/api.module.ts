import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { RecordsModule } from '../records/records.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { CorrelationMiddleware } from './correlation.middleware.js';
import { OperationsController } from './operations.controller.js';
import { ProblemFilter } from './problem.filter.js';
import { RecordsController } from './records.controller.js';
import { SyncController } from './sync.controller.js';

/**
 * The public API. Brief §2: no application ever reaches past this boundary —
 * there is no direct database access for anyone but the kernel itself.
 */
@Module({
  imports: [RecordsModule, SyncModule],
  controllers: [RecordsController, SyncController, OperationsController],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
