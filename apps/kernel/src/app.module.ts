import { Module } from '@nestjs/common';
import { ApiModule } from './api/api.module.js';
import { RecordsModule } from './records/records.module.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [StorageModule, RecordsModule, ApiModule],
})
export class AppModule {}
