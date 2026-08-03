import { Module } from '@nestjs/common';

import { PartyLinkRepository } from './party-link.repository.js';
import { PartyLinkService } from './party-link.service.js';

@Module({
  providers: [PartyLinkRepository, PartyLinkService],
  exports: [PartyLinkRepository, PartyLinkService],
})
export class IdentityModule {}
