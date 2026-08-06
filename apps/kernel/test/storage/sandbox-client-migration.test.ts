import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase();
});

after(async () => {
  await db.stop();
});

describe('sandbox client storage boundary', () => {
  test('the registration and client records remain append-only', async () => {
    const clientId = `sandbox-${uuidv7()}`;
    const developer = uuidv7();
    await db.app.query(
      `insert into kernel.client
        (id, client_id, display_name, owner_party, scopes, status, dataset)
       values ($1, $2, 'Sandbox', $3, $4, 'active', 'seed')`,
      [uuidv7(), clientId, developer, ['records:read']],
    );
    await db.app.query(
      `insert into kernel.sandbox_registration
        (id, client_id, developer_subject, terms_version, accepted_at)
       values ($1, $2, $3, '2026-08-06', now())`,
      [uuidv7(), clientId, developer],
    );

    await assert.rejects(
      db.owner.query(
        `update kernel.sandbox_registration set terms_version = 'changed'
          where client_id = $1`,
        [clientId],
      ),
      /client records are append-only/,
    );
    await assert.rejects(
      db.owner.query('delete from kernel.client where client_id = $1', [clientId]),
      /client records are append-only/,
    );
  });

  test('only the owner can reset seed rows and live deletion stays guarded', async () => {
    const seedId = uuidv7();
    const liveId = uuidv7();
    const party = uuidv7();
    for (const [id, dataset] of [
      [seedId, 'seed'],
      [liveId, 'live'],
    ] as const) {
      await db.owner.query(
        `insert into facts.record (
           id, type, record_class, schema_version, occurred_at,
           occurred_at_precision, recorded_at, asserted_by, body,
           lawful_basis, dataset
         ) values ($1, 'delivery', 'observation', '0.3.0', now(),
                   'day', now(), $2, '{}', 'special_data_consent', $3)`,
        [id, party, dataset],
      );
    }

    await assert.rejects(
      db.app.query('select kernel.reset_seed_corpus()'),
      /permission denied/,
    );
    await db.owner.query('select kernel.reset_seed_corpus()');

    const { rows } = await db.owner.query<{ id: string; dataset: string }>(
      'select id, dataset from facts.record where id = any($1::uuid[]) order by id',
      [[seedId, liveId]],
    );
    assert.deepEqual(rows, [{ id: liveId, dataset: 'live' }]);
    await assert.rejects(
      db.owner.query('delete from facts.record where id = $1', [liveId]),
      /refusing to delete live record/,
    );
  });
});
