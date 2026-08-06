import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import {
  ClientRepository,
  type ClientAuthorisationRow,
  type ClientRow,
  type ClientScope,
  type ClientStatus,
} from './client.repository.js';

export interface ClientRequestContext {
  requester: string;
  clientId: string;
  actingFor: string;
  dataset: 'live' | 'seed';
}

@Injectable()
export class ClientService {
  constructor(
    @Inject(ClientRepository) private readonly repository: ClientRepository,
  ) {}

  async register(input: {
    clientId: string;
    displayName: string;
    ownerParty: string;
    scopes: ClientScope[];
    status?: ClientStatus;
  }): Promise<ClientRow> {
    const current = await this.repository.current(input.clientId);
    if (current !== null && current.owner_party !== input.ownerParty) {
      throw new ForbiddenException('client registration is not permitted');
    }
    return this.repository.insert({
      id: uuidv7(),
      client_id: input.clientId,
      display_name: input.displayName,
      owner_party: input.ownerParty,
      scopes: [...new Set(input.scopes)],
      status: input.status ?? 'active',
      dataset: 'live',
    });
  }

  async registerSandbox(input: {
    clientId: string;
    displayName: string;
    developerSubject: string;
    termsVersion: string;
  }): Promise<ClientRow> {
    const current = await this.repository.current(input.clientId);
    if (current !== null) {
      if (
        current.dataset !== 'seed' ||
        current.owner_party !== input.developerSubject
      ) {
        throw new ForbiddenException('sandbox registration is not permitted');
      }
      return current;
    }
    const acceptedAt = new Date().toISOString();
    return this.repository.insertSandbox({
      client: {
        id: uuidv7(),
        client_id: input.clientId,
        display_name: input.displayName,
        owner_party: input.developerSubject,
        scopes: [...CLIENT_SANDBOX_SCOPES],
        status: 'active',
        dataset: 'seed',
      },
      registrationId: uuidv7(),
      termsVersion: input.termsVersion,
      acceptedAt,
    });
  }

  async authorise(input: {
    party: string;
    clientId: string;
    scopes: ClientScope[];
    expiresAt: string | null;
    grantedVia: string;
  }): Promise<ClientAuthorisationRow> {
    const client = await this.repository.current(input.clientId);
    const scopes = [...new Set(input.scopes)];
    if (
      client === null ||
      client.status !== 'active' ||
      client.dataset !== 'live' ||
      scopes.some((scope) => !client.scopes.includes(scope))
    ) {
      throw new ForbiddenException('client authorisation is not permitted');
    }
    return this.repository.insertAuthorisation({
      id: uuidv7(),
      party: input.party,
      client_id: input.clientId,
      scopes,
      granted_at: new Date().toISOString(),
      expires_at: input.expiresAt,
      granted_via: input.grantedVia,
    });
  }

  async resolve(
    requester: string | null,
    clientId: string | null,
    actingFor: string | null,
    requiredScope: ClientScope,
  ): Promise<ClientRequestContext | null> {
    if (clientId === null && actingFor === null) return null;
    if (clientId === null) {
      throw new ForbiddenException('client is not authorised to act');
    }

    const client = await this.repository.current(clientId);
    if (client?.dataset === 'seed') {
      if (
        requester === null ||
        actingFor !== null ||
        client.status !== 'active' ||
        !client.scopes.includes(requiredScope)
      ) {
        throw new ForbiddenException('sandbox client is not authorised');
      }
      return {
        requester,
        clientId,
        actingFor: requester,
        dataset: 'seed',
      };
    }

    if (actingFor === null) {
      throw new ForbiddenException('client is not authorised to act');
    }

    const now = new Date().toISOString();
    const authorisation = await this.repository.activeAuthorisation(
      actingFor,
      clientId,
      now,
    );
    if (
      client === null ||
      client.status !== 'active' ||
      authorisation === null ||
      !client.scopes.includes(requiredScope) ||
      !authorisation.scopes.includes(requiredScope)
    ) {
      throw new ForbiddenException('client is not authorised to act');
    }

    return { requester: actingFor, clientId, actingFor, dataset: 'live' };
  }

  authorisations(party: string): Promise<ClientAuthorisationRow[]> {
    return this.repository.authorisationsByParty(party);
  }

  revoke(
    id: string,
    party: string,
    revokedBy: string,
    reason: string | null,
  ): Promise<boolean> {
    return this.repository.revoke(
      id,
      uuidv7(),
      party,
      revokedBy,
      new Date().toISOString(),
      reason,
    );
  }
}

const CLIENT_SANDBOX_SCOPES = [
  'records:read',
  'records:write',
  'registry:read',
  'media:read',
  'media:write',
  'sync',
] as const satisfies readonly ClientScope[];