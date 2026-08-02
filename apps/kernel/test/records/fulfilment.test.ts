import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  entityDocument,
  ingestServiceFor,
  readingAs,
  retractionDocument,
} from '../helpers/fixtures.js';
import { ConsentService } from '../../src/consent/consent.service.js';
import { ReadService } from '../../src/records/read.service.js';
import {
  EMPTY_TALLY,
  resolveFulfilment,
} from '../../src/records/fulfilment.js';
import type { IngestService } from '../../src/records/ingest.service.js';

let db: TestDatabase;
let ingest: IngestService;
let read: ReadService;

before(async () => {
  db = await startTestDatabase();
  const assembled = ingestServiceFor(db.app);
  ingest = assembled.ingest;
  read = new ReadService(assembled.repository, new ConsentService());
});

after(async () => {
  await db.stop();
});

describe('fulfilment arithmetic', () => {
  test('nothing delivered leaves the whole commitment outstanding', () => {
    const fulfilment = resolveFulfilment(1000, EMPTY_TALLY);

    assert.equal(fulfilment.outstanding_kg, 1000);
    assert.equal(fulfilment.over_delivered, false);
    assert.equal(fulfilment.incomplete, false);
  });

  test('over-delivery is a negative outstanding, not a clamp to zero', () => {
    const fulfilment = resolveFulfilment(1000, {
      ...EMPTY_TALLY,
      deliveries: 3,
      delivered_kg: 1200,
    });

    assert.equal(fulfilment.outstanding_kg, -200);
    assert.equal(fulfilment.over_delivered, true);
  });

  test('an unconvertible delivery makes the total a floor, and says so', () => {
    const fulfilment = resolveFulfilment(1000, {
      deliveries: 4,
      confirmed: 2,
      unconvertible: 1,
      delivered_kg: 600,
    });

    assert.equal(fulfilment.incomplete, true);
    assert.equal(fulfilment.delivered_kg, 600);
  });

  test('an unnormalized commitment makes the shortfall unknowable', () => {
    const fulfilment = resolveFulfilment(null, {
      ...EMPTY_TALLY,
      deliveries: 2,
      delivered_kg: 400,
    });

    assert.equal(fulfilment.committed_kg, null);
    assert.equal(fulfilment.outstanding_kg, null);
    assert.equal(fulfilment.over_delivered, false);
  });
});

/**
 * The Agreement carries no counter and must never grow one: a stored total is a
 * second home for the truth, and it is wrong the moment a delivery is corrected
 * or retracted.
 */
describe('an agreement reports what its deliveries add up to', () => {
  const seller = uuidv7();

  const agreement = async (committedKg: number | null) => {
    const document = entityDocument('agreement', {
      id: uuidv7(),
      asserted_by: seller,
      quantity_committed: {
        raw_value: 10,
        raw_unit: 'tonne',
        raw_unit_label: null,
        normalized_kg: committedKg,
        conversion_id:
          committedKg === null
            ? null
            : '019fc600-0000-7000-8000-000000000002',
        measurement_method: 'coop_weighed',
        quality_flags: [],
      },
    });
    await ingest.ingest(document);
    return document.id as string;
  };

  const deliver = async (
    fulfils: string,
    kg: number | null,
    overrides: Record<string, unknown> = {},
  ) => {
    const document = entityDocument('delivery', {
      id: uuidv7(),
      asserted_by: seller,
      from_party: seller,
      fulfils,
      quantity: {
        raw_value: kg ?? 5,
        raw_unit: 'kg',
        raw_unit_label: null,
        normalized_kg: kg,
        conversion_id: null,
        measurement_method: 'coop_weighed',
        quality_flags: [],
      },
      ...overrides,
    });
    await ingest.ingest(document);
    return document.id as string;
  };

  test('an agreement with no deliveries is fully outstanding', async () => {
    const id = await agreement(10_000);

    const view = await read.get(id, readingAs(seller));

    assert.equal(view?.fulfilment?.deliveries, 0);
    assert.equal(view?.fulfilment?.outstanding_kg, 10_000);
  });

  test('deliveries are summed, not counted', async () => {
    const id = await agreement(10_000);
    await deliver(id, 3000);
    await deliver(id, 2500);

    const view = await read.get(id, readingAs(seller));

    assert.equal(view?.fulfilment?.deliveries, 2);
    assert.equal(view?.fulfilment?.delivered_kg, 5500);
    assert.equal(view?.fulfilment?.outstanding_kg, 4500);
  });

  test('a retracted delivery stops counting', async () => {
    const id = await agreement(10_000);
    await deliver(id, 3000);
    const wrong = await deliver(id, 2500);

    await ingest.ingest(retractionDocument(wrong, { asserted_by: seller }));

    const view = await read.get(id, readingAs(seller));

    assert.equal(view?.fulfilment?.deliveries, 1);
    assert.equal(view?.fulfilment?.delivered_kg, 3000);
  });

  test('a corrected delivery counts once, at the corrected weight', async () => {
    const id = await agreement(10_000);
    const first = await deliver(id, 3000);
    await deliver(id, 2800, { supersedes: first });

    const view = await read.get(id, readingAs(seller));

    assert.equal(view?.fulfilment?.deliveries, 1);
    assert.equal(view?.fulfilment?.delivered_kg, 2800);
  });

  test('confirmation is counted separately from arrival', async () => {
    const buyer = uuidv7();
    const id = await agreement(10_000);
    await deliver(id, 1000);
    await deliver(id, 1000, {
      counterparty_confirmed_at: '2026-04-01T00:00:00.000Z',
      counterparty_confirmed_by: buyer,
      to_party: buyer,
    });

    const view = await read.get(id, readingAs(seller));

    assert.equal(view?.fulfilment?.deliveries, 2);
    assert.equal(view?.fulfilment?.confirmed, 1);
  });

  test('a delivery that never reached kilograms is flagged, not silently dropped', async () => {
    const id = await agreement(10_000);
    await deliver(id, 2000);
    await deliver(id, null);

    const view = await read.get(id, readingAs(seller));

    assert.equal(view?.fulfilment?.deliveries, 2);
    assert.equal(view?.fulfilment?.unconvertible, 1);
    assert.equal(
      view?.fulfilment?.incomplete,
      true,
      'a percentage taken from this total would understate it',
    );
  });

  test('deliveries against another agreement are not borrowed', async () => {
    const mine = await agreement(10_000);
    const theirs = await agreement(10_000);
    await deliver(theirs, 4000);

    const view = await read.get(mine, readingAs(seller));

    assert.equal(view?.fulfilment?.deliveries, 0);
  });
});
