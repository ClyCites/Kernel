import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { RecordsModule } from './records/records.module.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [StorageModule, RecordsModule],
  controllers: [HealthController],
})
export class AppModule {}
