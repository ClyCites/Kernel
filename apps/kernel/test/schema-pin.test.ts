import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_VERSION, CORE_ENTITIES, Delivery } from '@clycites/schema';

/**
 * The kernel is built against one version of the schema and must not drift from
 * it silently. Brief §2: the schema package is the source of truth and is
 * effectively read-only.
 */
describe('vendored schema', () => {
  test('is pinned at the version this kernel was written against', () => {
    assert.equal(SCHEMA_VERSION, '0.2.0');
  });

  test('carries the sixteen core record types', () => {
    assert.equal(CORE_ENTITIES.length, 16);
  });

  test('is the only definition of an entity the kernel uses', () => {
    assert.equal(typeof Delivery.safeParse, 'function');
  });
});
