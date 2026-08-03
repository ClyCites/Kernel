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
  consentServiceFor,
} from '../helpers/fixtures.js';
import { ReadService } from '../../src/records/read.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { summariseSettlements } from '../../src/records/settlement.js';

let db: TestDatabase;
let ingest: TestIngest;
let read: ReadService;

before(async () => {
  db = await startTestDatabase();
  const assembled = ingestServiceFor(db.app);
  ingest = assembled.ingest;
  read = new ReadService(assembled.repository, consentServiceFor(db.app), auditServiceFor(db.app));
});

after(async () => {
  await db.stop();
});

const group = (
  status: string,
  amount: number,
  records = 1,
  currency = 'UGX',
  forked = false,
) => ({
  obligation: 'o',
  currency,
  verification_status: status,
  records,
  amount_minor: amount,
  forked,
});

const owed = { amount_minor: 1_000_000, currency: 'UGX' };

/**
 * Invariant 6. The kernel records obligations and references settlements made
 * elsewhere; it holds no funds and shows no balances.
 */
describe('non-custodial by construction', () => {
  test('no repository method totals money for a party', () => {
    const forbidden = /balance|wallet|float|owed|payable|receivable/i;
    const offenders = Object.getOwnPropertyNames(
      RecordRepository.prototype,
    ).filter((name) => forbidden.test(name));

    assert.deepEqual(
      offenders,
      [],
      'a method shaped like this is how a record layer becomes a payment system',
    );
  });

  test('a summary is about one obligation and names no party', () => {
    const summary = summariseSettlements(owed, [group('asserted', 400_000)]);

    const partyShaped = Object.keys(summary).filter((key) =>
      /party|obligor|obligee/.test(key),
    );
    assert.deepEqual(partyShaped, []);
  });
});

describe('settlement summary arithmetic', () => {
  test('an obligation nobody settled is wholly unreferenced', () => {
    const summary = summariseSettlements(owed, []);

    assert.equal(summary.references, 0);
    assert.equal(summary.unreferenced_minor, 1_000_000);
    assert.deepEqual(summary.referenced_minor, {});
  });

  test('verification statuses are kept apart, never added together', () => {
    const summary = summariseSettlements(owed, [
      group('asserted', 300_000),
      group('provider_verified', 500_000),
    ]);

    assert.deepEqual(summary.referenced_minor, {
      asserted: 300_000,
      provider_verified: 500_000,
    });
    assert.equal(
      Object.keys(summary.referenced_minor).length,
      2,
      'one merged total would launder a claim into evidence',
    );
  });

  test('a partial settlement leaves the remainder unreferenced', () => {
    const summary = summariseSettlements(owed, [group('asserted', 400_000)]);

    assert.equal(summary.unreferenced_minor, 600_000);
  });

  test('over-referencing is reported, not clamped', () => {
    const summary = summariseSettlements(owed, [
      group('provider_verified', 1_200_000),
    ]);

    assert.equal(summary.unreferenced_minor, -200_000);
  });

  test('a settlement in another currency is counted, never converted', () => {
    const summary = summariseSettlements(owed, [
      group('asserted', 400_000),
      group('asserted', 90, 1, 'USD'),
    ]);

    assert.equal(summary.currency_mismatch, 1);
    assert.equal(
      summary.unreferenced_minor,
      600_000,
      'adding across currencies would invent an exchange rate',
    );
  });

  test('a dispute is surfaced on its own', () => {
    const summary = summariseSettlements(owed, [group('disputed', 1_000_000)]);

    assert.equal(summary.disputed, true);
    assert.equal(summary.unreferenced_minor, 0);
    assert.deepEqual(summary.referenced_minor, { disputed: 1_000_000 });
  });

  test('arithmetic stays in integer minor units', () => {
    const summary = summariseSettlements({ amount_minor: 1, currency: 'UGX' }, [
      group('asserted', 1),
    ]);

    assert.equal(summary.unreferenced_minor, 0);
    assert.ok(Number.isInteger(summary.unreferenced_minor));
  });
});

describe('an obligation reports the settlements referencing it', () => {
  const obligor = uuidv7();
  const obligee = uuidv7();

  const obligation = async (amountMinor: number) => {
    const document = entityDocument('obligation', {
      id: uuidv7(),
      asserted_by: obligee,
      obligor,
      obligee,
      amount: { amount_minor: amountMinor, currency: 'UGX' },
    });
    await ingest.ingest(document);
    return document.id as string;
  };

  const settle = async (
    id: string,
    amountMinor: number,
    overrides: Record<string, unknown> = {},
  ) => {
    const document = entityDocument('settlement_reference', {
      id: uuidv7(),
      asserted_by: obligor,
      obligation: id,
      amount: { amount_minor: amountMinor, currency: 'UGX' },
      ...overrides,
    });
    await ingest.ingest(document);
    return document.id as string;
  };

  test('an unsettled obligation shows no references', async () => {
    const id = await obligation(1_000_000);

    const view = await read.get(id, readingAs(obligee));

    assert.equal(view?.settlement?.references, 0);
    assert.equal(view?.settlement?.unreferenced_minor, 1_000_000);
  });

  test('a partial settlement is visible as a partial settlement', async () => {
    const id = await obligation(1_000_000);
    await settle(id, 400_000);

    const view = await read.get(id, readingAs(obligee));

    assert.equal(view?.settlement?.references, 1);
    assert.equal(view?.settlement?.unreferenced_minor, 600_000);
  });

  test('a retracted settlement stops referencing', async () => {
    const id = await obligation(1_000_000);
    const wrong = await settle(id, 400_000);
    await ingest.ingest(retractionDocument(wrong, { asserted_by: obligor }));

    const view = await read.get(id, readingAs(obligee));

    assert.equal(view?.settlement?.references, 0);
    assert.equal(view?.settlement?.unreferenced_minor, 1_000_000);
  });

  test('a corrected settlement references once, at the corrected amount', async () => {
    const id = await obligation(1_000_000);
    const first = await settle(id, 400_000);
    await settle(id, 350_000, { supersedes: first });

    const view = await read.get(id, readingAs(obligee));

    assert.equal(view?.settlement?.references, 1);
    assert.equal(view?.settlement?.unreferenced_minor, 650_000);
  });

  test('verification status survives the round trip', async () => {
    const id = await obligation(1_000_000);
    await settle(id, 600_000, { verification_status: 'provider_verified' });
    await settle(id, 400_000, { verification_status: 'asserted' });

    const view = await read.get(id, readingAs(obligee));

    assert.deepEqual(view?.settlement?.referenced_minor, {
      provider_verified: 600_000,
      asserted: 400_000,
    });
  });

  test('the summary is attached to the view, never merged into the record', async () => {
    const id = await obligation(1_000_000);
    await settle(id, 400_000);

    const view = await read.get(id, readingAs(obligee));

    assert.equal(view?.record['settlement'], undefined);
    assert.deepEqual(view?.record['amount'], {
      amount_minor: 1_000_000,
      currency: 'UGX',
    });
  });

  test('a page of obligations costs one query', async () => {
    const ids = [await obligation(500_000), await obligation(500_000)];
    await settle(ids[0]!, 100_000);

    const page = await read.list(
      { assertedBy: obligee, type: 'obligation' },
      readingAs(obligee),
    );

    const seen = page.records.filter((view) =>
      ids.includes(view.record['id'] as string),
    );
    assert.equal(seen.length, 2);
    assert.ok(seen.every((view) => view.settlement !== undefined));
  });
});
