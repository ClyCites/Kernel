import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  deliveryDocument,
  entityDocument,
  retractionDocument,
} from '../helpers/fixtures.js';
import { DelegationService } from '../../src/records/delegation.service.js';
import { IngestService } from '../../src/records/ingest.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { RecordRejected } from '../../src/records/errors.js';
import { DeviceRepository } from '../../src/sync/device.repository.js';
import { MAX_BATCH, SyncService } from '../../src/sync/sync.service.js';

let db: TestDatabase;
let sync: SyncService;
let ingest: IngestService;

before(async () => {
  db = await startTestDatabase();
  const repository = new RecordRepository(db.app);
  ingest = new IngestService(repository, new DelegationService(repository));
  sync = new SyncService(ingest, repository, new DeviceRepository(db.app));
});

after(async () => {
  await db.stop();
});

describe('device registration', () => {
  test('a device registers once and re-registers idempotently', async () => {
    const registration = {
      device_id: uuidv7(),
      registered_by: uuidv7(),
      label: 'Masaka officer, tablet 4',
    };

    const first = await sync.register(registration);
    assert.equal(first.created, true);
    assert.equal(first.device.device_id, registration.device_id);
    assert.equal(first.device.label, registration.label);

    const again = await sync.register(registration);
    assert.equal(again.created, false);
    assert.deepEqual(again.device, first.device);
  });

  test('a device id already held by another party is refused', async () => {
    const device_id = uuidv7();
    await sync.register({
      device_id,
      registered_by: uuidv7(),
      label: 'first',
    });

    await assert.rejects(
      sync.register({ device_id, registered_by: uuidv7(), label: 'second' }),
      (error: unknown) =>
        error instanceof RecordRejected && error.code === 'id_conflict',
    );
  });

  test('a malformed registration is refused, not stored', async () => {
    await assert.rejects(
      sync.register({ device_id: 'not-a-uuid', registered_by: uuidv7() }),
      (error: unknown) =>
        error instanceof RecordRejected && error.code === 'malformed_record',
    );
  });
});

describe('draining an outbox', () => {
  test('one bad record does not strand the rest of the batch', async () => {
    const good = deliveryDocument();
    const alsoGood = entityDocument('harvest');
    const bad = deliveryDocument({ quantity: { raw_value: 'twelve' } });

    const results = await sync.drain([good, bad, alsoGood]);

    assert.deepEqual(
      results.map((result) => result.outcome),
      ['accepted', 'rejected', 'accepted'],
    );
    assert.equal(results[1]?.code, 'malformed_record');
    assert.equal(results[1]?.id, bad['id']);
    assert.ok((results[1]?.issues?.length ?? 0) > 0);

    // The accepted ones really are in the log.
    for (const document of [good, alsoGood]) {
      assert.ok(await sync.changes({ limit: 500 }).then((page) =>
        page.records.some((view) => view.record['id'] === document['id']),
      ));
    }
  });

  test('replaying a batch writes nothing twice', async () => {
    const batch = [deliveryDocument(), entityDocument('plot')];

    const first = await sync.drain(batch);
    assert.deepEqual(
      first.map((result) => result.outcome),
      ['accepted', 'accepted'],
    );

    const second = await sync.drain(batch);
    assert.deepEqual(
      second.map((result) => result.outcome),
      ['replayed', 'replayed'],
    );
    assert.deepEqual(
      second.map((result) => result.id),
      first.map((result) => result.id),
    );
  });

  test('a batch that is not an array is refused whole', async () => {
    await assert.rejects(
      sync.drain({ records: [] }),
      (error: unknown) =>
        error instanceof RecordRejected && error.code === 'malformed_record',
    );
  });

  test('an oversized batch is refused whole', async () => {
    const batch = Array.from({ length: MAX_BATCH + 1 }, () =>
      deliveryDocument(),
    );

    await assert.rejects(
      sync.drain(batch),
      (error: unknown) =>
        error instanceof RecordRejected && error.code === 'malformed_record',
    );
  });
});

describe('pulling changes', () => {
  test('paging walks the log forwards, once each, with no gaps', async () => {
    const before = await sync.changes({ limit: 500 });
    const known = new Set(before.records.map((view) => view.record['id']));

    const appended: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const stored = await ingest.ingest(deliveryDocument());
      appended.push(stored.record.id);
    }

    const seen: string[] = [];
    let cursor: string | null = before.next_cursor;
    for (let page = 0; page < 20; page += 1) {
      const changes: Awaited<ReturnType<SyncService['changes']>> =
        await sync.changes({ cursor: cursor ?? undefined, limit: 2 });
      for (const view of changes.records) {
        const id = view.record['id'] as string;
        assert.equal(known.has(id), false, `${id} was already known`);
        seen.push(id);
      }
      cursor = changes.next_cursor;
      if (!changes.has_more) break;
    }

    assert.deepEqual(seen, appended);
  });

  test('the feed carries superseded and retracted records', async () => {
    const asserter = uuidv7();
    const original = await ingest.ingest(
      deliveryDocument({ asserted_by: asserter, to_party: asserter }),
    );
    const start = await sync.changes({ limit: 500 });

    const correction = await ingest.ingest(
      deliveryDocument({
        asserted_by: asserter,
        to_party: asserter,
        supersedes: original.record.id,
      }),
    );
    const retracted = await ingest.ingest(
      entityDocument('harvest', { asserted_by: asserter }),
    );
    await ingest.ingest(
      retractionDocument(retracted.record.id, { asserted_by: asserter }),
    );

    const changes = await sync.changes({
      cursor: start.next_cursor ?? undefined,
      limit: 500,
    });
    const ids = changes.records.map((view) => view.record['id']);

    assert.ok(ids.includes(correction.record.id));
    assert.ok(
      ids.includes(retracted.record.id),
      'a device must see the retracted record to know it was retracted',
    );
    assert.equal(
      changes.records.find((view) => view.record['id'] === retracted.record.id)
        ?.retracted,
      true,
    );

    // The record the correction replaced is still reachable from earlier in
    // the feed, labelled as superseded.
    const whole = await sync.changes({ limit: 500 });
    assert.deepEqual(
      whole.records.find((view) => view.record['id'] === original.record.id)
        ?.superseded_by,
      [correction.record.id],
    );
  });

  test('a cursor we did not issue is refused', async () => {
    await assert.rejects(sync.changes({ cursor: 'not-a-cursor' }));
  });
});
