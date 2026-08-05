import { Module } from '@nestjs/common';

import { RecordsModule } from '../records/records.module.js';
import { FieldRepository } from './field.repository.js';
import { FieldService } from './field.service.js';

@Module({
  imports: [RecordsModule],
  providers: [FieldRepository, FieldService],
  exports: [FieldRepository, FieldService],
})
export class FieldModule {}