import { Global, Module } from '@nestjs/common';

import { ConsentGrantService } from './consent-grant.service.js';
import { ConsentRepository } from './consent.repository.js';
import { ConsentService } from './consent.service.js';
import { ObjectionRepository } from './objection.repository.js';
import { ObjectionService } from './objection.service.js';

/** Global so that no read path can be written without the guard in reach. */
@Global()
@Module({
  providers: [
    ConsentRepository,
    ConsentService,
    ConsentGrantService,
    ObjectionRepository,
    ObjectionService,
  ],
  exports: [
    ConsentRepository,
    ConsentService,
    ConsentGrantService,
    ObjectionRepository,
    ObjectionService,
  ],
})
export class ConsentModule {}
