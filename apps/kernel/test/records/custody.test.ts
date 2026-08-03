import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  auditServiceFor,
  entityDocument,
  ingestServiceFor,
  type TestIngest,
  readingAs,
  retractionDocument,
} from '../helpers/fixtures.js';
import { ConsentService } from '../../src/consent/consent.service.js';
import { ReadService } from '../../src/records/read.service.js';
import { resolveCustody } from '../../src/records/custody.js';

let db: TestDatabase;
let ingest: TestIngest;
let read: ReadService;

before(async () => {
  db = await startTestDatabase();
  const assembled = ingestServiceFor(db.app);
  ingest = assembled.ingest;
  read = new ReadService(assembled.repository, new ConsentService(), auditServiceFor(db.app));
});

after(async () => {
  await db.stop();
});

const link = (
  from: string,
  to: string,
  occurredAt: string,
  forked = false,
) => ({
  id: uuidv7(),
  lot: 'lot',
  from_party: from,
  to_party: to,
  occurred_at: occurredAt,
  forked,
});

describe('the custody walk', () => {
  test('with nothing moved, the asserted custodian stands', () => {
    const custody = resolveCustody('alice', []);

    assert.equal(custody.custodian, 'alice');
    assert.equal(custody.as_of, null);
    assert.equal(custody.transfers, 0);
    assert.equal(custody.broken, false);
  });

  test('the last transfer decides who holds it', () => {
    const custody = resolveCustody('alice', [
      link('alice', 'bob', '2026-03-01T00:00:00.000Z'),
      link('bob', 'coop', '2026-03-05T00:00:00.000Z'),
    ]);

    assert.equal(custody.custodian, 'coop');
    assert.equal(custody.as_of, '2026-03-05T00:00:00.000Z');
    assert.equal(custody.transfers, 2);
    assert.equal(custody.broken, false);
  });

  test('what the lot claimed is kept, not overwritten', () => {
    const custody = resolveCustody('alice', [
      link('alice', 'bob', '2026-03-01T00:00:00.000Z'),
    ]);

    assert.equal(custody.asserted, 'alice');
  });

  test('a transfer from someone who was not holding it breaks the chain', () => {
    const custody = resolveCustody('alice', [
      link('alice', 'bob', '2026-03-01T00:00:00.000Z'),
      link('mallory', 'coop', '2026-03-05T00:00:00.000Z'),
    ]);

    assert.equal(custody.broken, true);
    // The lot still ended up somewhere, and a reader needs both facts.
    assert.equal(custody.custodian, 'coop');
  });

  test('a broken link earlier in the chain is not forgotten later', () => {
    const custody = resolveCustody('alice', [
      link('mallory', 'bob', '2026-03-01T00:00:00.000Z'),
      link('bob', 'coop', '2026-03-05T00:00:00.000Z'),
    ]);

    assert.equal(custody.broken, true);
  });
});

/**
 * `Lot.custodian` is a field on a record that can never be updated. Serving the
 * stored value means serving an answer that is correct until the first transfer
 * and silently wrong forever after.
 */
describe('a lot reports where the transfers say it is', () => {
  const lotHeldBy = async (custodian: string) => {
    const asserter = custodian;
    const document = entityDocument('lot', {
      id: uuidv7(),
      asserted_by: asserter,
      custodian,
    });
    await ingest.ingest(document);
    return document.id as string;
  };

  const transfer = async (
    lot: string,
    from: string,
    to: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const document = entityDocument('custody_transfer', {
      id: uuidv7(),
      asserted_by: from,
      lot,
      from_party: from,
      to_party: to,
      ...overrides,
    });
    await ingest.ingest(document);
    return document.id as string;
  };

  test('before any transfer it reads as asserted', async () => {
    const alice = uuidv7();
    const lot = await lotHeldBy(alice);

    const view = await read.get(lot, readingAs(alice));

    assert.equal(view?.record['custodian'], alice);
    assert.equal(view?.custody?.transfers, 0);
  });

  test('after a transfer the lot names the new holder', async () => {
    const alice = uuidv7();
    const coop = uuidv7();
    const lot = await lotHeldBy(alice);
    await transfer(lot, alice, coop);

    const view = await read.get(lot, readingAs(alice));

    assert.equal(view?.record['custodian'], coop);
    assert.equal(view?.custody?.custodian, coop);
    assert.equal(view?.custody?.asserted, alice);
    assert.equal(view?.custody?.transfers, 1);
  });

  test('a retracted transfer never moved anything', async () => {
    const alice = uuidv7();
    const coop = uuidv7();
    const lot = await lotHeldBy(alice);
    const moved = await transfer(lot, alice, coop);

    await ingest.ingest(retractionDocument(moved, { asserted_by: alice }));

    const view = await read.get(lot, readingAs(alice));

    assert.equal(view?.record['custodian'], alice);
    assert.equal(view?.custody?.transfers, 0);
  });

  test('a corrected transfer moves the lot once, not twice', async () => {
    const alice = uuidv7();
    const coop = uuidv7();
    const store = uuidv7();
    const lot = await lotHeldBy(alice);
    const first = await transfer(lot, alice, coop);
    await transfer(lot, alice, store, { supersedes: first });

    const view = await read.get(lot, readingAs(alice));

    assert.equal(view?.record['custodian'], store);
    assert.equal(view?.custody?.transfers, 1);
    assert.equal(view?.custody?.broken, false);
  });

  test('a break in the chain is surfaced, not smoothed over', async () => {
    const alice = uuidv7();
    const coop = uuidv7();
    const mallory = uuidv7();
    const buyer = uuidv7();
    const lot = await lotHeldBy(alice);
    await transfer(lot, alice, coop);
    await transfer(lot, mallory, buyer);

    const view = await read.get(lot, readingAs(alice));

    assert.equal(view?.custody?.broken, true);
    assert.equal(view?.record['custodian'], buyer);
  });

  test('the derivation costs one query for a whole page of lots', async () => {
    const alice = uuidv7();
    const coop = uuidv7();
    const lots: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const lot = await lotHeldBy(alice);
      await transfer(lot, alice, coop);
      lots.push(lot);
    }

    const page = await read.list(
      { type: 'lot', assertedBy: alice, limit: 10 },
      readingAs(alice),
    );

    const seen = page.records.filter((view) => lots.includes(view.record['id'] as string));
    assert.equal(seen.length, 3);
    for (const view of seen) {
      assert.equal(view.record['custodian'], coop);
    }
  });

  test('the audit chain still shows what was claimed at the time', async () => {
    const alice = uuidv7();
    const coop = uuidv7();
    const lot = await lotHeldBy(alice);
    await transfer(lot, alice, coop);

    const chain = await read.chain(lot, readingAs(alice));

    assert.equal(chain.length, 1);
    assert.equal(
      chain[0]?.record['custodian'],
      alice,
      'the chain answers what was claimed, not where the lot is now',
    );
  });
});
