import { Global, Module } from '@nestjs/common';

import { ConversionService } from './conversion.service.js';
import { RegistryRepository } from './registry.repository.js';

/**
 * Global because reference data has no owner among the record modules: ingest
 * needs conversions, the operations controller needs the basis rollup, and
 * more will follow.
 */
@Global()
@Module({
  providers: [RegistryRepository, ConversionService],
  exports: [RegistryRepository, ConversionService],
})
export class RegistryModule {}
