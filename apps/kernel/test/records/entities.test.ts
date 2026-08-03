import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_ENTITIES } from '@clycites/schema';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  ENTITY_BODIES,
  auditServiceFor,
  entityDocument,
  ingestServiceFor,
  type TestIngest,
  readingAs,
  retractionDocument,
} from '../helpers/fixtures.js';
import { ConsentService } from '../../src/consent/consent.service.js';
import { ReadService } from '../../src/records/read.service.js';
import { registeredTypes } from '../../src/records/entity-registry.js';
import { SUBJECT_FIELDS, subjectFields } from '../../src/records/subjects.js';

let db: TestDatabase;
let ingest: TestIngest;
let read: ReadService;

before(async () => {
  db = await startTestDatabase();
  const { ingest: service, repository } = ingestServiceFor(db.app);
  ingest = service;
  read = new ReadService(repository, new ConsentService(), auditServiceFor(db.app));
});

after(async () => {
  await db.stop();
});

describe('the registry covers the schema', () => {
  test('every core entity is registered', () => {
    assert.deepEqual(registeredTypes(), [...CORE_ENTITIES].sort());
  });

  test('every core entity declares its subject fields', () => {
    const missing = CORE_ENTITIES.filter(
      (type) => subjectFields(type).length === 0,
    );
    assert.deepEqual(missing, []);
  });

  test('subject fields are declared for registered types only', () => {
    const stray = Object.keys(SUBJECT_FIELDS).filter(
      (type) => !registeredTypes().includes(type),
    );
    assert.deepEqual(stray, []);
  });
});

describe('every entity uses the same write and read path', () => {
  for (const type of Object.keys(ENTITY_BODIES)) {
    test(`${type} round-trips`, async () => {
      const asserter = uuidv7();
      const document = entityDocument(type, { asserted_by: asserter });
      const stored = await ingest.ingest(document);

      assert.equal(stored.record.type, type);
      assert.equal(stored.record.record_class, 'observation');

      const view = await read.get(stored.record.id, readingAs(asserter));
      assert.ok(view, `${type} should be readable`);
      assert.equal(view.record['type'], type);
      assert.equal(view.retracted, false);
      assert.deepEqual(view.superseded_by, []);
    });
  }

  test('retraction round-trips against a record that exists', async () => {
    const asserter = uuidv7();
    const target = await ingest.ingest(
      entityDocument('harvest', { asserted_by: asserter }),
    );
    const retraction = await ingest.ingest(
      retractionDocument(target.record.id, { asserted_by: asserter }),
    );

    assert.equal(retraction.record.type, 'retraction');

    const view = await read.get(target.record.id, readingAs(asserter));
    assert.equal(view?.retracted, true);

    const page = await read.list(
      { type: 'harvest', assertedBy: asserter },
      readingAs(asserter),
    );
    assert.equal(
      page.records.some((each) => each.record['id'] === target.record.id),
      false,
      'a retracted harvest should not appear in a default read',
    );
  });

  test('supersession works for an entity the write path was not built against', async () => {
    const holder = uuidv7();
    const first = await ingest.ingest(
      entityDocument('plot', { asserted_by: holder, held_by: holder }),
    );
    const second = await ingest.ingest(
      entityDocument('plot', {
        asserted_by: holder,
        held_by: holder,
        supersedes: first.record.id,
        local_name: 'Kyanja lower field, west of the path',
      }),
    );

    const chain = await read.chain(second.record.id, readingAs(holder));
    assert.deepEqual(
      chain.map((view) => view.record['id']),
      [first.record.id, second.record.id],
    );

    const page = await read.list(
      { type: 'plot', subject: holder },
      readingAs(holder),
    );
    assert.deepEqual(
      page.records.map((view) => view.record['id']),
      [second.record.id],
      'a default read shows the tip of the chain only',
    );
  });
});

describe('subject filters', () => {
  test('a party is found by its own id', async () => {
    const asserter = uuidv7();
    const stored = await ingest.ingest(
      entityDocument('party', { asserted_by: asserter }),
    );
    const page = await read.list(
      { subject: stored.record.id },
      readingAs(asserter),
    );

    assert.deepEqual(
      page.records.map((view) => view.record['id']),
      [stored.record.id],
    );
  });

  test('an agreement is found by a party nested in its parties array', async () => {
    const supplier = uuidv7();
    const asserter = uuidv7();
    const stored = await ingest.ingest(
      entityDocument('agreement', {
        asserted_by: asserter,
        parties: [
          { party: supplier, role: 'supplier' },
          { party: uuidv7(), role: 'buyer' },
        ],
      }),
    );

    const page = await read.list(
      { subject: supplier, type: 'agreement' },
      readingAs(asserter),
    );
    assert.deepEqual(
      page.records.map((view) => view.record['id']),
      [stored.record.id],
    );
  });

  test('an obligation is found by the delivery it arose from', async () => {
    const delivery = uuidv7();
    const asserter = uuidv7();
    const stored = await ingest.ingest(
      entityDocument('obligation', {
        asserted_by: asserter,
        arising_from: delivery,
      }),
    );

    const page = await read.list(
      { subject: delivery, type: 'obligation' },
      readingAs(asserter),
    );
    assert.deepEqual(
      page.records.map((view) => view.record['id']),
      [stored.record.id],
    );
  });

  test('a custody transfer is found by either side of it', async () => {
    const from = uuidv7();
    const to = uuidv7();
    const asserter = uuidv7();
    const stored = await ingest.ingest(
      entityDocument('custody_transfer', {
        asserted_by: asserter,
        from_party: from,
        to_party: to,
      }),
    );

    for (const party of [from, to]) {
      const page = await read.list({ subject: party }, readingAs(asserter));
      assert.deepEqual(
        page.records.map((view) => view.record['id']),
        [stored.record.id],
        `expected the transfer to be found by ${party}`,
      );
    }
  });
});

describe('quality flags reach the entities that need them', () => {
  /** Spec §9.1. Store the discrepancy; never refuse the record. */
  test('a lot whose components do not add up is flagged, not rejected', async () => {
    const asserter = uuidv7();
    const stored = await ingest.ingest(
      entityDocument('lot', {
        asserted_by: asserter,
        quantity: {
          raw_value: 40,
          raw_unit: 'bag',
          normalized_kg: 4000,
          conversion_id: uuidv7(),
          measurement_method: 'coop_weighed',
        },
        composed_of: [
          {
            source_ref: uuidv7(),
            source_type: 'harvest',
            quantity: {
              raw_value: 25,
              raw_unit: 'bag',
              normalized_kg: 2500,
              conversion_id: uuidv7(),
              measurement_method: 'coop_weighed',
            },
            basis: 'physical',
          },
          {
            source_ref: uuidv7(),
            source_type: 'harvest',
            quantity: {
              raw_value: 20,
              raw_unit: 'bag',
              normalized_kg: 2000,
              conversion_id: uuidv7(),
              measurement_method: 'coop_weighed',
            },
            basis: 'physical',
          },
        ],
      }),
    );

    assert.ok(
      stored.record.quality_flags.includes('mass_balance_discrepancy'),
      `expected the discrepancy to be flagged, got ${stored.record.quality_flags.join(', ')}`,
    );

    const view = await read.get(stored.record.id, readingAs(asserter));
    assert.ok(view?.quality_flags.includes('mass_balance_discrepancy'));
  });

  test('a lot that reconciles within tolerance is not flagged', async () => {
    const stored = await ingest.ingest(
      entityDocument('lot', {
        quantity: {
          raw_value: 45,
          raw_unit: 'bag',
          normalized_kg: 4470,
          conversion_id: uuidv7(),
          measurement_method: 'coop_weighed',
        },
        composed_of: [
          {
            source_ref: uuidv7(),
            source_type: 'harvest',
            quantity: {
              raw_value: 45,
              raw_unit: 'bag',
              normalized_kg: 4500,
              conversion_id: uuidv7(),
              measurement_method: 'coop_weighed',
            },
            basis: 'physical',
          },
        ],
      }),
    );

    assert.equal(
      stored.record.quality_flags.includes('mass_balance_discrepancy'),
      false,
    );
  });

  test('a custody transfer between one party and itself is flagged', async () => {
    const party = uuidv7();
    const stored = await ingest.ingest(
      entityDocument('custody_transfer', {
        from_party: party,
        to_party: party,
      }),
    );

    assert.ok(stored.record.quality_flags.includes('delivery_parties_identical'));
  });

  test('an unnormalized quantity is flagged on any entity carrying one', async () => {
    const stored = await ingest.ingest(
      entityDocument('harvest', {
        quantity: {
          raw_value: 3,
          raw_unit: 'basin',
          measurement_method: 'self_reported',
        },
      }),
    );

    assert.ok(stored.record.quality_flags.includes('quantity_not_normalized'));
    assert.ok(
      stored.record.quality_flags.includes('measurement_below_underwritable'),
    );
  });
});
