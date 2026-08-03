import { Global, Module } from '@nestjs/common';

import { ConsentGrantService } from './consent-grant.service.js';
import { ConsentRepository } from './consent.repository.js';
import { ConsentService } from './consent.service.js';

/** Global so that no read path can be written without the guard in reach. */
@Global()
@Module({
  providers: [ConsentRepository, ConsentService, ConsentGrantService],
  exports: [ConsentRepository, ConsentService, ConsentGrantService],
})
export class ConsentModule {}
