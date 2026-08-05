import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';

export const CLIENT_SCOPES = [
  'records:read',
  'records:write',
  'registry:read',
  'media:read',
  'media:write',
  'sync',
] as const;

export type ClientScope = (typeof CLIENT_SCOPES)[number];
export type ClientStatus = 'active' | 'suspended' | 'retired';

export interface ClientRow {
  id: string;
  client_id: string;
  display_name: string;
  owner_party: string;
  scopes: ClientScope[];
  status: ClientStatus;
  recorded_at: string;
}

export interface ClientAuthorisationRow {
  id: string;
  party: string;
  client_id: string;
  scopes: ClientScope[];
  granted_at: string;
  expires_at: string | null;
  granted_via: string;
  revoked_at: string | null;
}

@Injectable()
export class ClientRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  async current(clientId: string): Promise<ClientRow | null> {
    const { rows } = await this.pool.query<ClientRow>(
      `select id, client_id, display_name, owner_party, scopes, status,
              to_json(recorded_at) #>> '{}' as recorded_at
         from kernel.client
        where client_id = $1
        order by recorded_at desc, id desc
        limit 1`,
      [clientId],
    );
    return rows[0] ?? null;
  }

  async insert(client: Omit<ClientRow, 'recorded_at'>): Promise<ClientRow> {
    const { rows } = await this.pool.query<ClientRow>(
      `insert into kernel.client
         (id, client_id, display_name, owner_party, scopes, status)
       values ($1, $2, $3, $4, $5, $6)
       returning id, client_id, display_name, owner_party, scopes, status,
                 to_json(recorded_at) #>> '{}' as recorded_at`,
      [
        client.id,
        client.client_id,
        client.display_name,
        client.owner_party,
        client.scopes,
        client.status,
      ],
    );
    return rows[0]!;
  }

  async insertAuthorisation(
    authorisation: Omit<ClientAuthorisationRow, 'revoked_at'>,
  ): Promise<ClientAuthorisationRow> {
    const { rows } = await this.pool.query<ClientAuthorisationRow>(
      `insert into kernel.client_authorisation
         (id, party, client_id, scopes, granted_at, expires_at, granted_via)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, party, client_id, scopes,
                 to_json(granted_at) #>> '{}' as granted_at,
                 to_json(expires_at) #>> '{}' as expires_at,
                 granted_via, null::text as revoked_at`,
      [
        authorisation.id,
        authorisation.party,
        authorisation.client_id,
        authorisation.scopes,
        authorisation.granted_at,
        authorisation.expires_at,
        authorisation.granted_via,
      ],
    );
    return rows[0]!;
  }

  async activeAuthorisation(
    party: string,
    clientId: string,
    at: string,
  ): Promise<ClientAuthorisationRow | null> {
    const { rows } = await this.pool.query<ClientAuthorisationRow>(
      `select a.id, a.party, a.client_id, a.scopes,
              to_json(a.granted_at) #>> '{}' as granted_at,
              to_json(a.expires_at) #>> '{}' as expires_at,
              a.granted_via, null::text as revoked_at
         from kernel.client_authorisation a
        where a.party = $1 and a.client_id = $2
          and a.granted_at <= $3
          and (a.expires_at is null or a.expires_at > $3)
          and not exists (
            select 1 from kernel.client_authorisation_revocation r
             where r.authorisation = a.id and r.revoked_at <= $3
          )
        order by a.granted_at desc, a.id desc
        limit 1`,
      [party, clientId, at],
    );
    return rows[0] ?? null;
  }

  async authorisationsByParty(party: string): Promise<ClientAuthorisationRow[]> {
    const { rows } = await this.pool.query<ClientAuthorisationRow>(
      `select a.id, a.party, a.client_id, a.scopes,
              to_json(a.granted_at) #>> '{}' as granted_at,
              to_json(a.expires_at) #>> '{}' as expires_at,
              a.granted_via,
              to_json(r.revoked_at) #>> '{}' as revoked_at
         from kernel.client_authorisation a
         left join kernel.client_authorisation_revocation r
           on r.authorisation = a.id
        where a.party = $1
        order by a.granted_at desc`,
      [party],
    );
    return rows;
  }

  async revoke(
    authorisationId: string,
    revocationId: string,
    party: string,
    revokedBy: string,
    at: string,
    reason: string | null,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `insert into kernel.client_authorisation_revocation
         (id, authorisation, revoked_at, revoked_by, reason)
       select $1, a.id, $5, $4, $6
         from kernel.client_authorisation a
        where a.id = $2 and a.party = $3
       on conflict (authorisation) do nothing`,
      [revocationId, authorisationId, party, revokedBy, at, reason],
    );
    return (result.rowCount ?? 0) > 0;
  }
}