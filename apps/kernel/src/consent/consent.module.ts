import { Global, Module } from '@nestjs/common';

import { RecordsModule } from '../records/records.module.js';
import { ConsentGrantService } from './consent-grant.service.js';
import { ConsentRepository } from './consent.repository.js';
import { ConsentService } from './consent.service.js';
import { ObjectionRepository } from './objection.repository.js';
import { ObjectionService } from './objection.service.js';
import { SubjectAccessService } from './subject-access.service.js';

/** Global so that no read path can be written without the guard in reach. */
@Global()
@Module({
  // Subject access reads the log itself. Not a cycle: the guard reaches this
  // module through @Global rather than through an import.
  imports: [RecordsModule],
  providers: [
    ConsentRepository,
    ConsentService,
    ConsentGrantService,
    ObjectionRepository,
    ObjectionService,
    SubjectAccessService,
  ],
  exports: [
    ConsentRepository,
    ConsentService,
    ConsentGrantService,
    ObjectionRepository,
    ObjectionService,
    SubjectAccessService,
  ],
})
export class ConsentModule {}
