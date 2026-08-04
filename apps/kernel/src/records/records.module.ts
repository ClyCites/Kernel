import { Module } from '@nestjs/common';

import { DelegationService } from './delegation.service.js';
import { IngestService } from './ingest.service.js';
import { ReadService } from './read.service.js';
import { RecordRepository } from './record.repository.js';
import { InferenceRepository } from '../inference/inference.repository.js';

// `InferenceRepository` is provided here as well as in InferenceModule rather
// than imported from it. It holds no state beyond the shared pool, and making
// RecordsModule import InferenceModule would close a cycle, since the
// inference write path needs RecordRepository to append.
@Module({
  providers: [
    RecordRepository,
    InferenceRepository,
    DelegationService,
    IngestService,
    ReadService,
  ],
  exports: [RecordRepository, DelegationService, IngestService, ReadService],
})
export class RecordsModule {}
