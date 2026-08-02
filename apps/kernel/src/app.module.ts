import { Module } from '@nestjs/common';
import { ApiModule } from './api/api.module.js';
import { ConsentModule } from './consent/consent.module.js';
import { RecordsModule } from './records/records.module.js';
import { RegistryModule } from './registry/registry.module.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [
    StorageModule,
    ConsentModule,
    RegistryModule,
    RecordsModule,
    ApiModule,
  ],
})
export class AppModule {}
