import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { DelegationService } from '../../src/records/delegation.service.js';
import type { RecordRepository } from '../../src/records/record.repository.js';
import type { StoredRecord } from '../../src/records/record.js';

/**
 * Work order M5. Delegation scope is deny-unless-listed, and this is the test
 * that says so out loud.
 *
 * These go through `authorise` with a stub repository rather than through
 * ingest, on purpose: `@clycites/schema` refuses most of these bodies before
 * they reach the log, and the point of the exercise is that the kernel's own
 * check does not depend on that. A malformed scope arriving by any route —
 * a schema version that relaxed, a record written before a constraint, a bug —
 * must fail closed.
 */

const DELEGATOR = uuidv7();
const DELEGATE = uuidv7();

function stubRepository(body: Record<string, unknown>): RecordRepository {
  const record = {
    id: uuidv7(),
    type: 'delegation',
    body: {
      delegator: DELEGATOR,
      delegate: DELEGATE,
      granted_via: 'organisational_bylaw',
      ...body,
    },
  } as unknown as StoredRecord;

  return {
    findById: async () => record,
    findSupersessionChain: async () => [record],
    isRetracted: async () => false,
  } as unknown as RecordRepository;
}

async function authorise(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  const service = new DelegationService(stubRepository(body));
  try {
    await service.authorise({
      delegation: uuidv7(),
      delegator: DELEGATOR,
      delegate: DELEGATE,
      recordType: 'delivery',
      occurredAt: new Date().toISOString(),
    });
    return { ok: true, message: '' };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

describe('delegation scope is deny-unless-listed (M5, D7)', () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    ['no scope at all', {}],
    ['a null scope', { scope: null }],
    ['an empty scope', { scope: [] }],
    ['a scope naming something else', { scope: ['harvest', 'observation'] }],
    ['a scope that is a bare string', { scope: 'delivery' }],
    ['a scope that is an object', { scope: { delivery: true } }],
    ['a scope of non-strings', { scope: [1, true, null] }],
    ['a wildcard, which is not a thing here', { scope: ['*'] }],
    ['a scope of everything, spelled out', { scope: ['all'] }],
    ['a near miss', { scope: ['deliveries'] }],
    ['a case variant', { scope: ['Delivery'] }],
    ['a padded entry', { scope: [' delivery'] }],
  ];

  for (const [description, body] of refused) {
    test(`${description} does not authorise a delivery`, async () => {
      const result = await authorise(body);
      assert.equal(result.ok, false, `${description} should not authorise`);
      assert.match(result.message, /does not cover "delivery"/);
    });
  }

  test('an exact match, and only an exact match, authorises', async () => {
    const result = await authorise({ scope: ['harvest', 'delivery'] });
    assert.equal(result.ok, true, result.message);
  });

  /**
   * D7 asks whether scope should also be per field. It should not, yet.
   * Per-record-type is the narrower of the two, and narrowing later breaks
   * every delegation already in the field while widening breaks nothing. The
   * `granted_via` metric is what will answer D7 with data.
   */
  test('scope is not per field, and nothing pretends otherwise', async () => {
    const result = await authorise({
      scope: ['delivery'],
      // A field list on the delegation is not consulted. If it ever is, this
      // test fails and D7 has been resolved by accident rather than on
      // purpose.
      fields: ['quantity'],
    });

    assert.equal(result.ok, true, result.message);
  });
});
