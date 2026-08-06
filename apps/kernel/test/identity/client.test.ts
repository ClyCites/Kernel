import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { Request } from 'express';

import { AuditRepository } from '../../src/audit/audit.repository.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { AuditShipper } from '../../src/audit/audit.shipper.js';
import { ConsentRepository } from '../../src/consent/consent.repository.js';
import { InferenceRepository } from '../../src/inference/inference.repository.js';
import { ClientRepository } from '../../src/identity/client.repository.js';
import { ClientService } from '../../src/identity/client.service.js';
import {
  forceSeedDataset,
  requestedDataset,
} from '../../src/api/dataset.js';
import { ObjectionService } from '../../src/consent/objection.service.js';
import { ObjectionRepository } from '../../src/consent/objection.repository.js';
import { ReadService } from '../../src/records/read.service.js';
import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  consentServiceFor,
  deliveryDocument,
  ingestServiceFor,
} from '../helpers/fixtures.js';

let db: TestDatabase;
let clients: ClientService;
let read: ReadService;
let ingest: ReturnType<typeof ingestServiceFor>['ingest'];

before(async () => {
  db = await startTestDatabase();
  const clientRepository = new ClientRepository(db.app);
  clients = new ClientService(clientRepository);
  ({ ingest } = ingestServiceFor(db.app));
  const audit = new AuditService(
    new AuditRepository(db.app),
    new AuditShipper({
      AUDIT_SHIP_URL: '',
      AUDIT_SHIP_TOKEN: '',
      AUDIT_SHIP_INTERVAL_SECONDS: 10,
      AUDIT_SHIP_BATCH: 100,
    }),
  );
  read = new ReadService(
    new (await import('../../src/records/record.repository.js')).RecordRepository(db.app),
    consentServiceFor(db.app),
    new ObjectionService(
      new ObjectionRepository(db.app),
      new ConsentRepository(db.app),
      audit,
    ),
    audit,
    new InferenceRepository(db.app),
  );
});

after(async () => {
  await db.stop();
});

describe('a client is a narrowing lens over one party', () => {
  test('acting-for returns exactly the direct party view and audits both identities', async () => {
    const cooperative = uuidv7();
    const clientId = 'marketplace-test';
    await ingest.ingest(
      deliveryDocument({ asserted_by: cooperative, to_party: cooperative }),
    );
    await clients.register({
      clientId,
      displayName: 'Marketplace',
      ownerParty: uuidv7(),
      scopes: ['records:read', 'registry:read'],
    });
    const authorisation = await clients.authorise({
      party: cooperative,
      clientId,
      scopes: ['records:read'],
      expiresAt: null,
      grantedVia: 'in_person_signature',
    });

    const direct = await read.list({ type: 'delivery' }, { requester: cooperative });
    const context = await clients.resolve(null, clientId, cooperative, 'records:read');
    assert.ok(context);
    const represented = await read.list(
      { type: 'delivery' },
      {
        requester: context.requester,
        clientId: context.clientId,
        actingFor: context.actingFor,
      },
    );
    assert.deepEqual(represented, direct);

    const { rows: audit } = await db.owner.query<{
      client_id: string;
      acting_for: string;
      actor: string;
    }>(
      `select client_id, acting_for, actor from audit.entry
        where action = 'record.read' and client_id = $1`,
      [clientId],
    );
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0], {
      client_id: clientId,
      acting_for: cooperative,
      actor: cooperative,
    });

    const consentCount = await db.app.query(
      'select 1 from kernel.consent_grant where subject = $1',
      [cooperative],
    );
    assert.equal(consentCount.rowCount, 0, 'client authority is not disclosure consent');

    assert.equal(
      await clients.revoke(authorisation.id, cooperative, cooperative, 'finished'),
      true,
    );
    await assert.rejects(
      clients.resolve(null, clientId, cooperative, 'records:read'),
      ForbiddenException,
      'revocation is resolved on the next request',
    );
  });

  test('client and authorisation scopes only narrow', async () => {
    const cooperative = uuidv7();
    const narrowId = 'registry-only';
    await clients.register({
      clientId: narrowId,
      displayName: 'Registry browser',
      ownerParty: uuidv7(),
      scopes: ['registry:read'],
    });
    await clients.authorise({
      party: cooperative,
      clientId: narrowId,
      scopes: ['registry:read'],
      expiresAt: null,
      grantedVia: 'in_person_signature',
    });
    await assert.rejects(
      clients.resolve(null, narrowId, cooperative, 'records:read'),
      (error: unknown) =>
        error instanceof ForbiddenException &&
        error.message === 'client is not authorised to act' &&
        !error.message.includes(narrowId) &&
        !error.message.includes(cooperative),
    );

    await assert.rejects(
      clients.authorise({
        party: cooperative,
        clientId: narrowId,
        scopes: ['records:read'],
        expiresAt: null,
        grantedVia: 'in_person_signature',
      }),
      ForbiddenException,
      'an authorisation cannot exceed the registered client ceiling',
    );
  });

  test('a sandbox client is structurally confined to seed', async () => {
    const developer = uuidv7();
    const realParty = uuidv7();
    const clientId = `sandbox-${uuidv7()}`;
    const sandbox = await clients.registerSandbox({
      clientId,
      displayName: 'Developer sandbox',
      developerSubject: developer,
      termsVersion: '2026-08-06',
    });

    assert.equal(sandbox.dataset, 'seed');
    assert.deepEqual(
      await clients.resolve(developer, clientId, null, 'records:read'),
      { requester: developer, clientId, actingFor: developer, dataset: 'seed' },
    );
    await assert.rejects(
      clients.resolve(developer, clientId, realParty, 'records:read'),
      ForbiddenException,
    );
    await assert.rejects(
      clients.authorise({
        party: realParty,
        clientId,
        scopes: ['records:read'],
        expiresAt: null,
        grantedVia: 'test',
      }),
      ForbiddenException,
    );

    const directGrant = db.app.query(
      `insert into kernel.client_authorisation
         (id, party, client_id, scopes, granted_at, granted_via)
       values ($1, $2, $3, $4, now(), 'test')`,
      [uuidv7(), realParty, clientId, ['records:read']],
    );
    await assert.rejects(
      directGrant,
      /sandbox client .* cannot be authorised by a party/,
    );

    const request = {
      header: (name: string) =>
        name === 'x-clycites-dataset' ? 'live' : undefined,
    } as Request;
    forceSeedDataset(request);
    assert.equal(requestedDataset(request, true), 'seed');

    const { rows: registrations } = await db.app.query<{
      client_id: string;
      developer_subject: string;
      terms_version: string;
      dataset: string;
    }>(
      `select client_id, developer_subject, terms_version, dataset
         from kernel.sandbox_registration where client_id = $1`,
      [clientId],
    );
    assert.deepEqual(registrations, [
      {
        client_id: clientId,
        developer_subject: developer,
        terms_version: '2026-08-06',
        dataset: 'seed',
      },
    ]);
  });
});