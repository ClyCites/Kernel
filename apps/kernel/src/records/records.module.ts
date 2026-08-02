import { Module } from '@nestjs/common';

import { DelegationService } from './delegation.service.js';
import { IngestService } from './ingest.service.js';
import { RecordRepository } from './record.repository.js';

@Module({
  providers: [RecordRepository, DelegationService, IngestService],
  exports: [RecordRepository, DelegationService, IngestService],
})
export class RecordsModule {}
