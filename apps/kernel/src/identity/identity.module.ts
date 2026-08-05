import { Module } from '@nestjs/common';

import { PartyLinkRepository } from './party-link.repository.js';
import { PartyLinkService } from './party-link.service.js';
import { ClientRepository } from './client.repository.js';
import { ClientService } from './client.service.js';

@Module({
  providers: [PartyLinkRepository, PartyLinkService, ClientRepository, ClientService],
  exports: [PartyLinkRepository, PartyLinkService, ClientRepository, ClientService],
})
export class IdentityModule {}
