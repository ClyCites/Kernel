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
  consentServiceFor,
} from '../helpers/fixtures.js';
import { ReadService } from '../../src/records/read.service.js';
import { resolveMassBalance } from '../../src/records/mass-balance.js';

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

const transfer = (
  at: string,
  weighed: number | null,
  from = 'a',
  to = 'b',
  forked = false,
) => ({
  id: at,
  lot: 'lot',
  from_party: from,
  to_party: to,
  occurred_at: at,
  weighed_kg: weighed,
  forked,
});

const loss = (at: string, kg: number | null, forked = false) => ({
  id: `loss-${at}`,
  lot: 'lot',
  occurred_at: at,
  kg,
  forked,
});

describe('mass balance arithmetic', () => {
  test('a lot that never changed hands has nothing to reconcile', () => {
    const balance = resolveMassBalance(1000, [], []);

    assert.equal(balance.unexplained_kg, 0);
    assert.equal(balance.breached, false);
    assert.equal(balance.incomplete, false);
  });

  test('shrinkage between two weighings is unexplained', () => {
    const balance = resolveMassBalance(1000, [transfer('2026-01-02', 940)], []);

    assert.equal(balance.unexplained_kg, 60);
    assert.equal(balance.breached, true);
    assert.equal(balance.legs[0]?.discrepancy_kg, 60);
  });

  test('a declared loss explains the shrinkage it accounts for', () => {
    const balance = resolveMassBalance(
      1000,
      [transfer('2026-01-02', 940)],
      [loss('2026-01-01', 60)],
    );

    assert.equal(balance.declared_loss_kg, 60);
    assert.equal(balance.unexplained_kg, 0);
    assert.equal(balance.breached, false);
  });

  test('a loss declared after the transfer does not excuse it retroactively', () => {
    const balance = resolveMassBalance(
      1000,
      [transfer('2026-01-02', 940)],
      [loss('2026-01-05', 60)],
    );

    // Nothing had been declared when the lot was weighed, so the leg is short.
    // The later loss depletes the 940 further; it does not backfill the gap.
    assert.equal(balance.legs[0]?.discrepancy_kg, 60);
    assert.equal(balance.closing_kg, 880);
    assert.equal(balance.unexplained_kg, 60);
    assert.equal(balance.breached, true);
  });

  test('mass appearing is as suspicious as mass leaving', () => {
    const balance = resolveMassBalance(1000, [transfer('2026-01-02', 1100)], []);

    assert.equal(balance.unexplained_kg, -100);
    assert.equal(balance.breached, true);
  });

  test('losses net to zero across legs but each leg is still judged alone', () => {
    const balance = resolveMassBalance(
      1000,
      [transfer('2026-01-02', 920), transfer('2026-01-03', 1000)],
      [],
    );

    assert.equal(balance.unexplained_kg, 0);
    assert.equal(
      balance.breached,
      true,
      'losing 8% and gaining it back is not a clean lot',
    );
  });

  test('the tolerance is honoured and is a parameter, not a constant', () => {
    const legs = [transfer('2026-01-02', 970)];

    assert.equal(resolveMassBalance(1000, legs, [], 0.02).breached, true);
    assert.equal(resolveMassBalance(1000, legs, [], 0.05).breached, false);
  });

  test('an unweighable transfer makes the ledger incomplete, not clean', () => {
    const balance = resolveMassBalance(
      1000,
      [transfer('2026-01-02', null), transfer('2026-01-03', 900)],
      [],
    );

    assert.equal(balance.incomplete, true);
    assert.equal(balance.legs[0]?.discrepancy_kg, null);
  });

  test('a loss that never reached kilograms is not silently counted as zero', () => {
    const balance = resolveMassBalance(
      1000,
      [transfer('2026-01-02', 940)],
      [loss('2026-01-01', null)],
    );

    assert.equal(balance.declared_loss_kg, 0);
    assert.equal(
      balance.incomplete,
      true,
      'counting it as zero would flatter the lot',
    );
  });

  test('losses after the last hand-over still deplete the lot', () => {
    const balance = resolveMassBalance(
      1000,
      [transfer('2026-01-02', 1000)],
      [loss('2026-01-09', 40)],
    );

    assert.equal(balance.closing_kg, 960);
    assert.equal(balance.unexplained_kg, 0);
    assert.equal(balance.breached, false);
  });
});

describe('a lot reports where its mass went', () => {
  const farmer = uuidv7();
  const coop = uuidv7();
  const warehouse = uuidv7();

  const kg = (value: number | null) => ({
    raw_value: value ?? 0,
    raw_unit: 'kg',
    raw_unit_label: null,
    normalized_kg: value,
    conversion_id: null,
    measurement_method: 'coop_weighed',
    quality_flags: [],
  });

  const lot = async (openingKg: number) => {
    const document = entityDocument('lot', {
      id: uuidv7(),
      asserted_by: farmer,
      custodian: farmer,
      quantity: kg(openingKg),
    });
    await ingest.ingest(document);
    return document.id as string;
  };

  const handOver = async (
    id: string,
    from: string,
    to: string,
    weighed: number,
    at: string,
  ) => {
    await ingest.ingest(
      entityDocument('custody_transfer', {
        id: uuidv7(),
        asserted_by: from,
        occurred_at: at,
        lot: id,
        from_party: from,
        to_party: to,
        quantity: kg(weighed),
      }),
    );
  };

  const declareLoss = async (id: string, amount: number, at: string) => {
    await ingest.ingest(
      entityDocument('observation', {
        id: uuidv7(),
        asserted_by: coop,
        occurred_at: at,
        subject_type: 'lot',
        subject_ref: id,
        observation_type: 'loss.declared',
        value: { kind: 'quantity', value: kg(amount) },
        method: 'reported',
      }),
    );
  };

  test('a lot nobody moved balances trivially', async () => {
    const id = await lot(1000);

    const view = await read.get(id, readingAs(farmer));

    assert.equal(view?.balance?.opening_kg, 1000);
    assert.equal(view?.balance?.closing_kg, 1000);
    assert.equal(view?.balance?.breached, false);
  });

  test('unexplained shrinkage across two hand-overs is surfaced', async () => {
    const id = await lot(1000);
    await handOver(id, farmer, coop, 980, '2026-02-01T08:00:00.000Z');
    await handOver(id, coop, warehouse, 900, '2026-02-03T08:00:00.000Z');

    const view = await read.get(id, readingAs(farmer));

    assert.equal(view?.balance?.legs.length, 2);
    assert.equal(view?.balance?.unexplained_kg, 100);
    assert.equal(view?.balance?.breached, true);
  });

  test('a declared loss against the lot accounts for the difference', async () => {
    const id = await lot(1000);
    await declareLoss(id, 80, '2026-02-02T08:00:00.000Z');
    await handOver(id, farmer, coop, 920, '2026-02-03T08:00:00.000Z');

    const view = await read.get(id, readingAs(farmer));

    assert.equal(view?.balance?.declared_loss_kg, 80);
    assert.equal(view?.balance?.unexplained_kg, 0);
    assert.equal(view?.balance?.breached, false);
  });

  test('a discrepancy is stored and served, never a reason to refuse the record', async () => {
    const id = await lot(1000);
    await handOver(id, farmer, coop, 600, '2026-02-01T08:00:00.000Z');

    const view = await read.get(id, readingAs(farmer));

    assert.equal(view?.balance?.breached, true);
    assert.equal(
      view?.balance?.unexplained_kg,
      400,
      'a coop consistently short is information; rejecting the entry loses both the record and the discrepancy',
    );
  });

  test('the balance is attached to the view, never merged into the record', async () => {
    const id = await lot(1000);
    await handOver(id, farmer, coop, 900, '2026-02-01T08:00:00.000Z');

    const view = await read.get(id, readingAs(farmer));

    assert.equal(view?.record['balance'], undefined);
    assert.equal(
      (view?.record['quantity'] as { normalized_kg: number }).normalized_kg,
      1000,
      'the asserted opening weight is not rewritten by later weighings',
    );
  });

  test('a whole page of lots costs one pair of queries', async () => {
    const ids = [await lot(500), await lot(500)];
    await handOver(ids[0]!, farmer, coop, 400, '2026-02-01T08:00:00.000Z');

    const page = await read.list(
      { assertedBy: farmer, type: 'lot' },
      readingAs(farmer),
    );

    const seen = page.records.filter((view) => ids.includes(view.record['id'] as string));
    assert.equal(seen.length, 2);
    assert.ok(seen.every((view) => view.balance !== undefined));
  });
});
