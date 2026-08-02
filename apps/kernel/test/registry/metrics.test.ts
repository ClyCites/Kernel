import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import { deliveryDocument, ingestServiceFor } from '../helpers/fixtures.js';
import { OperationsController } from '../../src/api/operations.controller.js';
import { RegistryRepository } from '../../src/registry/registry.repository.js';

let db: TestDatabase;
let operations: OperationsController;

before(async () => {
  db = await startTestDatabase();
  operations = new OperationsController(db.app, new RegistryRepository(db.app));
});

after(async () => {
  await db.stop();
});

const MAIZE_BAG = '019fc600-0000-7000-8000-000000000020';
const COFFEE_BAG = '019fc600-0000-7000-8000-000000000010';

const bags = (conversion: string, kg: number, count: number) => ({
  raw_value: count,
  raw_unit: 'bag',
  raw_unit_label: null,
  normalized_kg: kg,
  conversion_id: conversion,
  measurement_method: 'coop_weighed',
  quality_flags: [],
});

/**
 * The measure exists to keep an uncomfortable number in view. Nearly every
 * commodity factor in the registry is a trade rumour the kernel has written
 * down; reporting kilograms without saying so would be the dishonest part.
 */
describe('the assumed-conversion share is reported', () => {
  test('an empty log reports zero rather than dividing by it', async () => {
    const body = await operations.metrics();

    assert.match(body, /kernel_assumed_conversion_share 0\n/);  });

  test('tonnage is attributed to the basis of the factor behind it', async () => {
    const { ingest } = ingestServiceFor(db.app);

    // 1000 kg on a guessed maize factor, 600 kg on the ICO standard.
    await ingest.ingest(
      deliveryDocument({
        id: uuidv7(),
        commodity: 'crop.maize.grain',
        quantity: bags(MAIZE_BAG, 1000, 10),
      }),
    );
    await ingest.ingest(
      deliveryDocument({
        id: uuidv7(),
        commodity: 'crop.coffee.green',
        quantity: bags(COFFEE_BAG, 600, 10),
      }),
    );

    const body = await operations.metrics();

    assert.match(body, /kernel_normalized_kg_total\{basis="assumed_default"\} 1000/);
    assert.match(body, /kernel_normalized_kg_total\{basis="published_standard"\} 600/);

    const share = Number(
      /^kernel_assumed_conversion_share (\S+)$/m.exec(body)?.[1] ?? 'NaN',
    );
    assert.ok(Math.abs(share - 1000 / 1600) < 1e-9, String(share));
  });

  test('mass behind an unresolvable factor is counted, not dropped', async () => {
    const { ingest } = ingestServiceFor(db.app);

    await ingest.ingest(
      deliveryDocument({
        id: uuidv7(),
        commodity: 'crop.maize.grain',
        quantity: bags(uuidv7(), 400, 4),
      }),
    );

    const body = await operations.metrics();

    assert.match(body, /kernel_normalized_kg_total\{basis="unresolved"\} 400/);
  });

  test('the exposition is Prometheus text, typed and documented', async () => {
    const body = await operations.metrics();

    assert.match(body, /# HELP kernel_assumed_conversion_share /);
    assert.match(body, /# TYPE kernel_assumed_conversion_share gauge/);
    assert.ok(body.endsWith('\n'));
  });
});
