import { Module } from '@nestjs/common';

import { RecordsModule } from '../records/records.module.js';
import { InferenceRepository } from './inference.repository.js';
import { InferenceService } from './inference.service.js';

@Module({
  imports: [RecordsModule],
  providers: [InferenceRepository, InferenceService],
  exports: [InferenceRepository, InferenceService],
})
export class InferenceModule {}
