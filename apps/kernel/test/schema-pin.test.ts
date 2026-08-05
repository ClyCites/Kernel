import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { SCHEMA_VERSION, CORE_ENTITIES, Delivery } from '@clycites/schema';

import {
  ENTITY_SCHEMAS,
  schemaFor,
} from '../src/records/entity-registry.js';

/**
 * The kernel is built against one version of the schema and must not drift from
 * it silently. Brief §2: the schema package is the source of truth and is
 * effectively read-only.
 */
describe('vendored schema', () => {
  test('is pinned at the version this kernel was written against', () => {
    assert.equal(SCHEMA_VERSION, '0.3.0');
  });

  test('carries the sixteen core record types', () => {
    assert.equal(CORE_ENTITIES.length, 16);
  });

  test('is the only definition of an entity the kernel uses', () => {
    assert.equal(typeof Delivery.safeParse, 'function');
  });
});

/**
 * Brief §4 invariant 6. ClyCites records that money is owed and references
 * settlements that happened somewhere else. It never holds funds — which is
 * what keeps it outside the National Payment Systems Act, and what this test
 * exists to notice someone quietly changing.
 */
describe('non-custodial', () => {
  const CUSTODIAL = /wallet|balance|float|ledger_entry|funds/i;

  test('there is no entity that could hold money', () => {
    const custodial = CORE_ENTITIES.filter((type) => CUSTODIAL.test(type));
    assert.deepEqual(custodial, []);

    for (const type of ['wallet', 'balance', 'account_balance']) {
      assert.equal(schemaFor(type), null, `${type} must not be storable`);
    }
  });

  test('no entity carries a balance-shaped field', () => {
    const offenders: string[] = [];

    for (const [type, schema] of Object.entries(ENTITY_SCHEMAS)) {
      const json = z.toJSONSchema(schema, {
        target: 'draft-2020-12',
        io: 'output',
      }) as { properties?: Record<string, unknown> };

      for (const field of Object.keys(json.properties ?? {})) {
        if (CUSTODIAL.test(field)) offenders.push(`${type}.${field}`);
      }
    }

    assert.deepEqual(offenders, []);
  });

  test('money is referenced, never moved', () => {
    // An obligation is what is owed; a settlement reference is evidence it was
    // paid elsewhere. Neither implies custody, and both must stay present —
    // dropping them is how the repayment signal gets lost.
    assert.notEqual(schemaFor('obligation'), null);
    assert.notEqual(schemaFor('settlement_reference'), null);
  });
});
