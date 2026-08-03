import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  auditServiceFor,
  deliveryDocument,
  entityDocument,
  ingestServiceFor,
  type TestIngest,
  readingAs,
  consentServiceFor,
  objectionServiceFor,
} from '../helpers/fixtures.js';
import { ReadService } from '../../src/records/read.service.js';
import { RegistryRepository } from '../../src/registry/registry.repository.js';
import { loadConfig } from '../../src/config.js';
import { requestedDataset } from '../../src/api/dataset.js';
import type { Request } from 'express';
import type { RecordRepository } from '../../src/records/record.repository.js';

let db: TestDatabase;
let ingest: TestIngest;
let repository: RecordRepository;
let read: ReadService;
let registry: RegistryRepository;

before(async () => {
  db = await startTestDatabase();
  const assembled = ingestServiceFor(db.app);
  ingest = assembled.ingest;
  repository = assembled.repository;
  read = new ReadService(assembled.repository, consentServiceFor(db.app), objectionServiceFor(db.app), auditServiceFor(db.app));
  registry = new RegistryRepository(db.app);
});

after(async () => {
  await db.stop();
});

/** A request carrying only the headers `requestedDataset` reads. */
const requestWith = (headers: Record<string, string>): Request =>
  ({ header: (name: string) => headers[name.toLowerCase()] }) as Request;

describe('the dataset discriminator', () => {
  test('a write with no context is live', async () => {
    const { record } = await ingest.ingest(deliveryDocument());

    assert.equal(record.dataset, 'live');
  });

  test('a seed record is invisible to a default read by id', async () => {
    const document = deliveryDocument();
    const { record } = await ingest.ingest(document, { dataset: 'seed' });

    assert.equal(record.dataset, 'seed');
    assert.equal(await read.get(record.id, readingAs(record.asserted_by)), null);
    assert.notEqual(
      await read.get(record.id, readingAs(record.asserted_by, 'seed')),
      null,
    );
  });

  test('a seed record is absent from a default listing', async () => {
    const asserter = uuidv7();
    const live = await ingest.ingest(
      deliveryDocument({ asserted_by: asserter }),
    );
    const seed = await ingest.ingest(
      deliveryDocument({ asserted_by: asserter }),
      { dataset: 'seed' },
    );

    const page = await read.list(
      { assertedBy: asserter },
      readingAs(asserter),
    );
    const ids = page.records.map((view) => view.record['id']);

    assert.deepEqual(ids, [live.record.id]);
    assert.equal(ids.includes(seed.record.id), false);
  });

  test('a seed retraction cannot hide a live record', async () => {
    // Same target id from both corpora. Only the live retraction may count.
    const target = await ingest.ingest(deliveryDocument());
    await db.owner.query(
      `insert into facts.record (
         id, type, record_class, schema_version, occurred_at,
         occurred_at_precision, recorded_at, asserted_by, body, ext,
         quality_flags, dataset, lawful_basis
       ) values (
         $1, 'retraction', 'observation', $2, now(), 'instant', now(), $3,
         $4::jsonb, '{}'::jsonb, '{}', 'seed', 'special_data_consent'
       )`,
      [
        uuidv7(),
        target.record.schema_version,
        target.record.asserted_by,
        JSON.stringify({ target: target.record.id, reason: 'fabricated' }),
      ],
    );

    const view = await read.get(
      target.record.id,
      readingAs(target.record.asserted_by),
    );

    assert.notEqual(view, null);
    assert.equal(view?.retracted, false);
  });

  test('a live record cannot be superseded from the seed corpus', async () => {
    const original = await ingest.ingest(deliveryDocument());
    const correction = deliveryDocument({
      asserted_by: original.record.asserted_by,
      supersedes: original.record.id,
    });

    await assert.rejects(
      ingest.ingest(correction, { dataset: 'seed' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'supersession_invalid');
        // Deliberately "not in the log" rather than a cross-corpus message: a
        // caller must not be able to probe live ids by reading the error.
        assert.match(error.message, /is not in the log/);
        return true;
      },
    );
  });

  test('derived fulfilment does not count seed deliveries', async () => {
    const supplier = uuidv7();
    const agreement = await ingest.ingest(
      entityDocument('agreement', { asserted_by: supplier }),
    );

    await ingest.ingest(
      deliveryDocument({
        asserted_by: supplier,
        fulfils: agreement.record.id,
      }),
      { dataset: 'seed' },
    );

    const view = await read.get(agreement.record.id, readingAs(supplier));

    assert.equal(view?.fulfilment?.deliveries, 0);
  });

  test('seed tonnage never reaches the operational metrics', async () => {
    const before = await registry.tonnageByConversionBasis();
    const beforeTotal = [...before.values()].reduce((sum, kg) => sum + kg, 0);

    await ingest.ingest(deliveryDocument(), { dataset: 'seed' });

    const afterSeed = await registry.tonnageByConversionBasis();
    const afterTotal = [...afterSeed.values()].reduce((sum, kg) => sum + kg, 0);

    assert.equal(afterTotal, beforeTotal);
  });

  test('the replication feed is scoped to one corpus', async () => {
    const asserter = uuidv7();
    await ingest.ingest(deliveryDocument({ asserted_by: asserter }), {
      dataset: 'seed',
    });

    const live = await repository.since(undefined, 50, asserter, 'live');
    const seed = await repository.since(undefined, 50, asserter, 'seed');

    assert.equal(live.length, 0);
    assert.equal(seed.length, 1);
  });
});

describe('the seed ingest switch', () => {
  test('the header is ignored when seeding is off', () => {
    const request = requestWith({ 'x-clycites-dataset': 'seed' });

    assert.equal(requestedDataset(request, false), 'live');
  });

  test('the header is honoured when seeding is on', () => {
    const request = requestWith({ 'x-clycites-dataset': 'seed' });

    assert.equal(requestedDataset(request, true), 'seed');
  });

  test('an unrecognised header value falls back to live', () => {
    const request = requestWith({ 'x-clycites-dataset': 'production' });

    assert.equal(requestedDataset(request, true), 'live');
  });

  test('seeding is off unless the environment says exactly "true"', () => {
    const base = {
      DATABASE_URL: 'postgres://x',
      MIGRATOR_DATABASE_URL: 'postgres://x',
      KERNEL_APP_PASSWORD: 'x',
    };

    assert.equal(loadConfig(base).SEED_INGEST_ENABLED, false);
    assert.equal(
      loadConfig({ ...base, SEED_INGEST_ENABLED: 'true' }).SEED_INGEST_ENABLED,
      true,
    );
    // A coercing parser would read this as true. That is the whole reason the
    // field is an enum rather than a boolean.
    assert.throws(() => loadConfig({ ...base, SEED_INGEST_ENABLED: 'no' }));
  });
});
