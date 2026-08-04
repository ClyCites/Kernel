import { Module } from '@nestjs/common';

import { DelegationService } from './delegation.service.js';
import { IngestService } from './ingest.service.js';
import { ReadService } from './read.service.js';
import { RecordRepository } from './record.repository.js';
import { InferenceRepository } from '../inference/inference.repository.js';
import { MediaRepository } from '../media/media.repository.js';

// `InferenceRepository` is provided here as well as in InferenceModule rather
// than imported from it. It holds no state beyond the shared pool, and making
// RecordsModule import InferenceModule would close a cycle, since the
// inference write path needs RecordRepository to append. `MediaRepository` is
// here for the mirror-image reason: MediaModule imports this one.
@Module({
  providers: [
    RecordRepository,
    InferenceRepository,
    MediaRepository,
    DelegationService,
    IngestService,
    ReadService,
  ],
  exports: [
    RecordRepository,
    MediaRepository,
    DelegationService,
    IngestService,
    ReadService,
  ],
})
export class RecordsModule {}
