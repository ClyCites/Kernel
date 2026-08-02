import { Module } from '@nestjs/common';

import { RecordsModule } from '../records/records.module.js';
import { DeviceRepository } from './device.repository.js';
import { SyncService } from './sync.service.js';

@Module({
  imports: [RecordsModule],
  providers: [DeviceRepository, SyncService],
  exports: [DeviceRepository, SyncService],
})
export class SyncModule {}
