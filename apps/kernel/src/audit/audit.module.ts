import { Global, Module } from '@nestjs/common';

import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';
import { AuditShipper } from './audit.shipper.js';

/**
 * Global, like storage. Every path that can disclose or append a record needs
 * this, and a module that has to be imported is a module somebody forgets to
 * import — which here means a disclosure with no statutory record of it.
 */
@Global()
@Module({
  providers: [AuditRepository, AuditShipper, AuditService],
  exports: [AuditService, AuditShipper],
})
export class AuditModule {}
