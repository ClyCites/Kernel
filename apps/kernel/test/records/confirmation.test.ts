import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  resolveConfirmation,
  UNCONFIRMED,
  type ConfirmationRow,
} from '../../src/records/confirmation.js';

const row = (over: Partial<ConfirmationRow>): ConfirmationRow => ({
  delivery: 'd1',
  confirming_party: 'farmer',
  asserted_by: 'farmer',
  delegated: false,
  by_bylaw: false,
  channel: 'ussd_pin',
  occurred_at: '2026-08-01T10:00:00.000Z',
  ...over,
});

describe('resolving a delivery confirmation', () => {
  test('no rows is not confirmed, and says nothing else', () => {
    assert.deepEqual(resolveConfirmation([]), UNCONFIRMED);
    assert.equal(UNCONFIRMED.confirmed, false);
    assert.equal(UNCONFIRMED.independent, false);
  });

  test('a direct confirmation is independent', () => {
    const result = resolveConfirmation([row({})]);
    assert.equal(result.confirmed, true);
    assert.equal(result.independent, true);
    assert.equal(result.delegated, false);
    assert.equal(result.confirmed_by, 'farmer');
  });

  /**
   * The whole point of the finding. A coop confirming on the farmer's behalf
   * under its own bylaws is weaker evidence than the farmer confirming, and a
   * lender must be able to see which one they are looking at.
   */
  test('a delegated confirmation is confirmed and not independent', () => {
    const result = resolveConfirmation([
      row({ asserted_by: 'coop', delegated: true, by_bylaw: true }),
    ]);
    assert.equal(result.confirmed, true);
    assert.equal(result.independent, false);
    assert.equal(result.delegated, true);
    assert.equal(result.by_bylaw, true);
  });

  test('a direct confirmation wins over an earlier delegated one', () => {
    const result = resolveConfirmation([
      row({
        asserted_by: 'coop',
        delegated: true,
        occurred_at: '2026-08-01T09:00:00.000Z',
      }),
      row({ occurred_at: '2026-08-02T09:00:00.000Z' }),
    ]);
    assert.equal(result.independent, true);
    assert.equal(result.confirmed_by, 'farmer');
    assert.equal(result.count, 2);
  });

  test('the earliest is chosen when every confirmation is delegated', () => {
    const result = resolveConfirmation([
      row({ asserted_by: 'b', delegated: true, occurred_at: '2026-08-03T09:00:00.000Z' }),
      row({ asserted_by: 'a', delegated: true, occurred_at: '2026-08-01T09:00:00.000Z' }),
    ]);
    assert.equal(result.independent, false);
    assert.equal(result.confirmed_at, '2026-08-01T09:00:00.000Z');
  });
});
