import { Global, Module } from '@nestjs/common';

import { ConsentService } from './consent.service.js';

/** Global so that no read path can be written without the guard in reach. */
@Global()
@Module({
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
