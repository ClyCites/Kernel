import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import {
  CONSENT_PURPOSES,
  ConsentDenied,
  ConsentService,
  INTEGRITY_OPERATIONS,
  type ConsentRequest,
} from '../../src/consent/consent.service.js';
import { subjectsOf } from '../../src/records/subjects.js';
import { entityDocument } from '../helpers/fixtures.js';

const consent = new ConsentService();

function request(overrides: Partial<ConsentRequest> = {}): ConsentRequest {
  const party = uuidv7();
  return {
    subjects: [party],
    asserters: [party],
    requester: party,
    purpose: null,
    record_types: ['delivery'],
    at: '2026-07-18T09:00:00Z',
    ...overrides,
  };
}

/**
 * The stub's whole job is to fail closed. These tests exist so that widening it
 * is a deliberate act with a red suite attached, not a quiet edit.
 */
describe('consent is not implemented and therefore denies', () => {
  for (const purpose of CONSENT_PURPOSES) {
    test(`${purpose} is denied`, () => {
      const decision = consent.decide(request({ purpose }));

      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, 'consent_not_implemented');
      assert.match(decision.detail, /no consent implementation exists/);
    });
  }

  test('a purpose is denied even when the requester is the subject', () => {
    const party = uuidv7();
    const decision = consent.decide(
      request({
        subjects: [party],
        asserters: [party],
        requester: party,
        purpose: 'credit_assessment',
      }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'consent_not_implemented');
  });

  test('a third party with no purpose is still denied', () => {
    const decision = consent.decide(
      request({ requester: uuidv7(), purpose: null }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'consent_not_implemented');
  });

  test('no verified subject means no disclosure', () => {
    const decision = consent.decide(request({ requester: null }));

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'consent_not_implemented');
  });
});

describe('the three internal uses', () => {
  test('a subject reading their own records is allowed', () => {
    const party = uuidv7();
    const decision = consent.decide(
      request({ subjects: [party], asserters: [uuidv7()], requester: party }),
    );

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'self_read');
  });

  test('the party that asserted a record may read it back', () => {
    const officer = uuidv7();
    const decision = consent.decide(
      request({
        subjects: [uuidv7(), uuidv7()],
        asserters: [officer, officer],
        requester: officer,
      }),
    );

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'asserter_read');
  });

  for (const operation of INTEGRITY_OPERATIONS) {
    test(`kernel ${operation} is allowed and is not a disclosure`, () => {
      const decision = consent.integrity(operation);

      assert.equal(decision.allowed, true);
      assert.equal(decision.reason, 'kernel_integrity');
    });
  }

  test('there is no request that yields kernel_integrity', () => {
    // The integrity allowance is not reachable from request input. If it ever
    // becomes reachable, a caller can claim it.
    const shapes: ConsentRequest[] = [
      request({ purpose: null }),
      request({ requester: uuidv7() }),
      request({ subjects: [], asserters: [] }),
      request({ record_types: [] }),
    ];

    for (const shape of shapes) {
      assert.notEqual(consent.decide(shape).reason, 'kernel_integrity');
    }
  });
});

describe('the obvious bypasses', () => {
  test('bundling another party into a self-read is rejected', () => {
    const me = uuidv7();
    const someoneElse = uuidv7();

    const decision = consent.decide(
      request({
        subjects: [me, someoneElse],
        asserters: [uuidv7()],
        requester: me,
      }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'foreign_subject_in_self_read');
  });

  test('a mixed asserter set does not qualify as an asserter read', () => {
    const officer = uuidv7();
    const decision = consent.decide(
      request({
        subjects: [uuidv7(), uuidv7()],
        asserters: [officer, uuidv7()],
        requester: officer,
      }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'consent_not_implemented');
  });

  test('a record with no identifiable subject cannot be released', () => {
    const decision = consent.decide(request({ subjects: [] }));

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'unattributed_record');
    assert.match(decision.detail, /no subject/);
  });

  test('subjects come from the record, not from the caller', () => {
    const farmer = uuidv7();
    const document = entityDocument('harvest', { plot: farmer });

    // Whatever a caller claims, this is what the guard is built from.
    assert.deepEqual(subjectsOf(document).includes(farmer), true);
    assert.equal(subjectsOf(document).includes('anything-a-caller-says'), false);
  });
});

describe('the guard', () => {
  test('throws rather than returning a partial result', () => {
    assert.throws(
      () => consent.assertPermitted(request({ purpose: 'credit_assessment' })),
      (error: unknown) => {
        assert.ok(error instanceof ConsentDenied);
        assert.equal(error.decision.allowed, false);
        assert.equal(error.decision.reason, 'consent_not_implemented');
        assert.equal(error.code, 'consent_denied');
        return true;
      },
    );
  });

  test('returns the decision when it allows, for the audit log', () => {
    const decision = consent.assertPermitted(request());

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'self_read');
  });
});
