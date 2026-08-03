import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import {
  ConsentDenied,
  ConsentService,
  INTEGRITY_OPERATIONS,
  type ConsentRequest,
  type RecordFacts,
} from '../../src/consent/consent.service.js';
import { ConsentGrantService } from '../../src/consent/consent-grant.service.js';
import {
  consentGrantServiceFor,
  consentServiceFor,
  entityDocument,
  ingestServiceFor,
  type TestIngest,
} from '../helpers/fixtures.js';
import { startTestDatabase, type TestDatabase } from '../helpers/database.js';

let db: TestDatabase;
let ingest: TestIngest;
let consent: ConsentService;
/** The same kernel with the s.9 answer counsel has not yet given. */
let permissive: ConsentService;
let grants: ConsentGrantService;

const COOP = uuidv7();
const FARMER = uuidv7();
const LENDER = uuidv7();
const CLERK = uuidv7();

const SEASON = '2026-07-18T00:00:00Z';
/**
 * The moment of the read, and deliberately well after the moment of the grant.
 * Grants are written at wall-clock now; a decision timestamped before that is
 * a decision about a grant that had not been given yet, which is its own
 * (correct) refusal and not the one these tests are about.
 */
const NOW = '2027-01-01T00:00:00Z';

before(async () => {
  db = await startTestDatabase();
  ({ ingest } = ingestServiceFor(db.app));
  consent = consentServiceFor(db.app);
  permissive = consentServiceFor(db.app, false);
  grants = consentGrantServiceFor(db.app);

  await ingest.ingest(
    entityDocument('membership', {
      member: FARMER,
      organisation: COOP,
      joined_at: '2026-01-01',
      occurred_at: '2026-01-01T00:00:00Z',
      asserted_by: COOP,
    }),
  );
});

after(async () => {
  await db.stop();
});

/** A priced delivery from the farmer to the coop, written by a coop clerk. */
function delivery(overrides: Partial<RecordFacts> = {}): RecordFacts {
  return {
    id: uuidv7(),
    type: 'delivery',
    subjects: [FARMER, COOP],
    parties: [FARMER, COOP],
    via: null,
    asserted_by: CLERK,
    on_behalf_of: COOP,
    occurred_at: SEASON,
    financial: true,
    lawful_basis: 'special_data_consent',
    ...overrides,
  };
}

/**
 * A harvest, which names no party at all. It reaches one only through the plot
 * it was taken from — the case that made a farmer a third party to their own
 * production record.
 */
function harvest(plot: string, overrides: Partial<RecordFacts> = {}): RecordFacts {
  return delivery({
    type: 'harvest',
    subjects: [plot],
    parties: [],
    via: plot,
    financial: false,
    lawful_basis: 'contract_performance',
    ...overrides,
  });
}

/** A custody transfer: the same two parties, no money in it. */
function custody(overrides: Partial<RecordFacts> = {}): RecordFacts {
  return delivery({
    type: 'custody_transfer',
    financial: false,
    lawful_basis: 'contract_performance',
    ...overrides,
  });
}

function asking(
  requester: string,
  records: RecordFacts[],
  overrides: Partial<ConsentRequest> = {},
): ConsentRequest {
  return {
    records,
    requester,
    purpose: null,
    dataset: 'live',
    at: NOW,
    ...overrides,
  };
}

const grantTo = async (
  grantee: string,
  overrides: Partial<Parameters<ConsentGrantService['grant']>[0]> = {},
): Promise<string> => {
  const row = await grants.grant({
    subject: FARMER,
    grantee,
    purpose: 'market_intelligence',
    recordTypes: ['delivery'],
    expiresAt: null,
    grantedVia: 'in_person_signature',
    evidence: [],
    dataset: 'live',
    ...overrides,
  });
  return row.id;
};

/**
 * Farm Intelligence reads Planting, Harvest and Observation and nothing else.
 * None of them names a party, so until the hop existed the farmer whose
 * production record it is was a third party to it.
 */
describe('a record reaches its party in one hop', () => {
  let plot: string;

  before(async () => {
    plot = uuidv7();
    await ingest.ingest(
      entityDocument('plot', {
        id: plot,
        held_by: FARMER,
        occurred_at: '2026-01-02T00:00:00Z',
        asserted_by: FARMER,
      }),
    );
  });

  test('the farmer reads their own harvest as self', async () => {
    const decision = await consent.decide(asking(FARMER, [harvest(plot)]));

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'self_read');
    assert.equal(decision.access, 'self');
  });

  test('their cooperative reads it as member body', async () => {
    const decision = await consent.decide(asking(COOP, [harvest(plot)]));

    // The coop is not a party to a harvest at all. It reaches this one because
    // every party the record resolves to — the plot's holder — is its member,
    // and its officer recorded it on the coop's behalf under a delegation.
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'member_body');
    assert.equal(decision.access, 'member_body');
  });

  test('a cooperative does not reach a harvest it had no hand in', async () => {
    // Same farmer, same membership, a plot the coop has nothing to do with.
    // Belonging to a cooperative for input credit on one plot does not hand
    // it the farmer's other plots and their sales to a private trader.
    const decision = await consent.decide(
      asking(
        COOP,
        [harvest(plot, { asserted_by: FARMER, on_behalf_of: null })],
        { purpose: 'advisory' },
      ),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'no_grant');
  });

  test('a cooperative does not reach a member’s dealings with an outsider', async () => {
    const outsider = uuidv7();
    const decision = await consent.decide(
      asking(
        COOP,
        [
          custody({
            parties: [FARMER, outsider],
            subjects: [FARMER, outsider],
            asserted_by: outsider,
          }),
        ],
        { purpose: 'advisory' },
      ),
    );

    // Nothing financial here, so a member body would have been let through.
    // Needing a grant at all is what proves it classified as a third party.
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'no_grant');
  });

  test('a stranger is still a third party to it', async () => {
    const stranger = uuidv7();
    const decision = await consent.decide(
      asking(stranger, [harvest(plot)], { purpose: 'advisory' }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'no_grant');
  });

  test('a hop that resolves to nobody is denied, and says so', async () => {
    const decision = await consent.decide(
      asking(FARMER, [harvest(uuidv7())], { purpose: 'advisory' }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'subject_unresolvable');
  });

  test('the asserter still reaches a record whose subject will not resolve', async () => {
    const scout = uuidv7();
    const decision = await consent.decide(
      asking(scout, [harvest(uuidv7(), { asserted_by: scout })]),
    );

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'asserter_read');
  });

  test('the hop is one hop, so a harvest does not inherit the plot’s own plot', async () => {
    // The plot resolves to its holder and stops. Nothing follows `held_by`
    // onward, which is what keeps this a lookup rather than a graph walk.
    const decision = await consent.decide(asking(FARMER, [harvest(plot)]));

    assert.deepEqual(decision.grants, []);
    assert.equal(decision.access, 'self');
  });
});

describe('the four access classes', () => {
  test('the asserter reads what it wrote, with no grant', async () => {
    const decision = await consent.decide(
      asking(CLERK, [delivery({ asserted_by: CLERK })]),
    );

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'asserter_read');
    assert.equal(decision.access, 'asserter');
    assert.deepEqual(decision.grants, []);
  });

  test('a party reads its own non-financial record as self', async () => {
    // The other party holds no membership in this one, so nothing upgrades it.
    const outsider = uuidv7();
    const decision = await consent.decide(
      asking(FARMER, [
        custody({ subjects: [FARMER, outsider], parties: [FARMER, outsider] }),
      ]),
    );

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'self_read');
  });

  test('a member body reads a non-financial record with no grant', async () => {
    const decision = await consent.decide(asking(COOP, [custody()]));

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'member_body');
    assert.equal(decision.access, 'member_body');
    assert.deepEqual(decision.grants, []);
  });

  test('a third party with no grant is denied', async () => {
    const decision = await consent.decide(
      asking(LENDER, [custody()], { purpose: 'credit_assessment' }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'no_grant');
  });
});

/**
 * The s.9 question, isolated. Everything here turns on one flag, and nothing
 * else in the kernel branches on s.9 — see docs/decisions/0029-consent.md.
 */
describe('member body and financial information', () => {
  test('a priced delivery is denied while the flag stands', async () => {
    const decision = await consent.decide(
      asking(COOP, [delivery()], { purpose: 'market_intelligence' }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'financial_needs_consent');
  });

  test('a grant from the farmer unlocks the same read', async () => {
    const id = await grantTo(COOP);
    const decision = await consent.decide(
      asking(COOP, [delivery()], { purpose: 'market_intelligence' }),
    );

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'member_body_with_grant');
    assert.deepEqual(decision.grants, [id]);
  });

  /**
   * COUNSEL-DEPENDENT. This test asserts what the kernel does if s.9(3)(c) is
   * held to cover a cooperative processing its members' financial data. It is
   * not an assertion that it does. If the answer comes back no, the flag stays
   * true in every environment and this test still passes, because it sets the
   * flag itself rather than reading the deployed one.
   */
  test('with the flag false, member body alone suffices', async () => {
    const decision = await permissive.decide(
      asking(COOP, [delivery({ subjects: [uuidv7(), COOP] })], {
        purpose: 'market_intelligence',
      }),
    );

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'member_body');
    assert.deepEqual(decision.grants, []);
  });
});

describe('membership comes from the record, not the request', () => {
  test('a caller claiming a membership it does not hold is a third party', async () => {
    const impostor = uuidv7();
    const decision = await consent.decide(
      asking(impostor, [
        custody({
          subjects: [FARMER, impostor],
          parties: [FARMER, impostor],
        }),
      ]),
    );

    // A party to the record, so `self` — but not a member body, which is the
    // class that would have carried the farmer's data with it.
    assert.equal(decision.reason, 'self_read');
    assert.notEqual(decision.access, 'member_body');
  });

  test('membership resolves at occurred_at, so a lapsed member is out of reach', async () => {
    const left = uuidv7();
    await ingest.ingest(
      entityDocument('membership', {
        member: left,
        organisation: COOP,
        joined_at: '2025-01-01',
        left_at: '2025-12-31',
        occurred_at: '2025-01-01T00:00:00Z',
        asserted_by: COOP,
      }),
    );

    const lastSeason = await consent.decide(
      asking(COOP, [
        custody({
          subjects: [left, COOP],
          parties: [left, COOP],
          occurred_at: '2025-06-01T00:00:00Z',
        }),
      ]),
    );
    assert.equal(lastSeason.reason, 'member_body');

    const thisSeason = await consent.decide(
      asking(COOP, [custody({ subjects: [left, COOP], parties: [left, COOP] })]),
    );
    assert.notEqual(thisSeason.access, 'member_body');
  });

  /**
   * The obvious exploit. A coop may read its member's delivery; it may not
   * hand that read to a lender by standing behind it. Member-body access is a
   * property of the requester, and there is no requester but one.
   */
  test('member-body access does not transit to a third party', async () => {
    await grantTo(COOP, { purpose: 'credit_assessment' });

    const decision = await consent.decide(
      asking(LENDER, [delivery()], { purpose: 'credit_assessment' }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'no_grant');
    assert.deepEqual(decision.grants, []);
  });
});

describe('grants are resolved at request time', () => {
  test('an expired grant does not authorise the read', async () => {
    const subject = uuidv7();
    const grantee = uuidv7();
    await grants.grant({
      subject,
      grantee,
      purpose: 'credit_assessment',
      recordTypes: ['delivery'],
      expiresAt: '2026-12-01T00:00:00Z',
      grantedVia: 'ussd_confirmation',
      evidence: [],
      dataset: 'live',
    });

    const decision = await consent.decide(
      asking(
        grantee,
        [delivery({ subjects: [subject], parties: [subject] })],
        { purpose: 'credit_assessment' },
      ),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'grant_expired');
  });

  test('a withdrawn grant does not authorise the read', async () => {
    const subject = uuidv7();
    const grantee = uuidv7();
    const row = await grants.grant({
      subject,
      grantee,
      purpose: 'credit_assessment',
      recordTypes: ['delivery'],
      expiresAt: null,
      grantedVia: 'witnessed',
      evidence: [],
      dataset: 'live',
    });
    await grants.revoke(row.id, subject, 'changed my mind', 'live');

    const decision = await consent.decide(
      asking(
        grantee,
        [delivery({ subjects: [subject], parties: [subject] })],
        { purpose: 'credit_assessment' },
      ),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'grant_revoked');
  });

  test('a grant for another purpose is not a grant for this one', async () => {
    const subject = uuidv7();
    const grantee = uuidv7();
    await grants.grant({
      subject,
      grantee,
      purpose: 'advisory',
      recordTypes: ['delivery'],
      expiresAt: null,
      grantedVia: 'in_person_signature',
      evidence: [],
      dataset: 'live',
    });

    const decision = await consent.decide(
      asking(
        grantee,
        [delivery({ subjects: [subject], parties: [subject] })],
        { purpose: 'credit_assessment' },
      ),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'grant_wrong_purpose');
  });

  test('a grant that does not cover this record type is refused distinctly', async () => {
    const subject = uuidv7();
    const grantee = uuidv7();
    await grants.grant({
      subject,
      grantee,
      purpose: 'credit_assessment',
      recordTypes: ['harvest'],
      expiresAt: null,
      grantedVia: 'in_person_signature',
      evidence: [],
      dataset: 'live',
    });

    const decision = await consent.decide(
      asking(
        grantee,
        [delivery({ subjects: [subject], parties: [subject] })],
        { purpose: 'credit_assessment' },
      ),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'grant_wrong_record_type');
  });

  test('a third party with a live grant is allowed', async () => {
    const subject = uuidv7();
    const grantee = uuidv7();
    const row = await grants.grant({
      subject,
      grantee,
      purpose: 'credit_assessment',
      recordTypes: ['delivery'],
      expiresAt: null,
      grantedVia: 'in_person_signature',
      evidence: [],
      dataset: 'live',
    });

    const decision = await consent.decide(
      asking(
        grantee,
        [delivery({ subjects: [subject], parties: [subject] })],
        { purpose: 'credit_assessment' },
      ),
    );

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'third_party_with_grant');
    assert.deepEqual(decision.grants, [row.id]);
  });
});

describe('refusals that are not about grants at all', () => {
  test('an unattributed record cannot be decided about', async () => {
    const decision = await consent.decide(
      asking(FARMER, [delivery({ subjects: [], parties: [] })]),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'unattributed_record');
  });

  test('no verified subject means nothing is released', async () => {
    const decision = await consent.decide({
      records: [custody()],
      requester: null,
      purpose: 'advisory',
      dataset: 'live',
      at: NOW,
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'no_verified_subject');
  });

  test('a purpose is required for anything but your own records', async () => {
    const decision = await consent.decide(asking(LENDER, [custody()]));

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'purpose_required');
  });

  test('financial data held on another basis is not disclosable', async () => {
    const decision = await consent.decide(
      asking(LENDER, [delivery({ lawful_basis: 'legitimate_interest' })], {
        purpose: 'credit_assessment',
      }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'lawful_basis_forbids');
  });

  test('one record the caller may not see refuses the whole page', async () => {
    const stranger = uuidv7();
    const decision = await consent.decide(
      asking(
        FARMER,
        [
          custody(),
          custody({ subjects: [stranger], parties: [stranger] }),
        ],
        { purpose: 'advisory' },
      ),
    );

    assert.equal(decision.allowed, false);
  });
});

describe('the guard and the integrity path', () => {
  test('assertPermitted throws rather than filtering', async () => {
    await assert.rejects(
      () =>
        consent.assertPermitted(
          asking(LENDER, [custody()], { purpose: 'advisory' }),
        ),
      (error: unknown) => error instanceof ConsentDenied,
    );
  });

  for (const operation of INTEGRITY_OPERATIONS) {
    test(`${operation} is not a disclosure`, () => {
      const decision = consent.integrity(operation);

      assert.equal(decision.allowed, true);
      assert.equal(decision.reason, 'kernel_integrity');
      assert.deepEqual(decision.grants, []);
    });
  }
});

/**
 * The read the stub made impossible: a cooperative listing what its members
 * delivered to it. Work order N's definition of done.
 */
describe('a marketplace-shaped read', () => {
  test('a coop lists its members deliveries once they have consented', async () => {
    const members = [uuidv7(), uuidv7(), uuidv7()];
    const coop = uuidv7();

    for (const member of members) {
      await ingest.ingest(
        entityDocument('membership', {
          member,
          organisation: coop,
          joined_at: '2026-01-01',
          occurred_at: '2026-01-01T00:00:00Z',
          asserted_by: coop,
        }),
      );
      await grants.grant({
        subject: member,
        grantee: coop,
        purpose: 'market_intelligence',
        recordTypes: ['delivery'],
        expiresAt: null,
        grantedVia: 'in_person_signature',
        evidence: [],
        dataset: 'live',
      });
    }

    const decision = await consent.decide(
      asking(
        coop,
        members.map((member) =>
          delivery({ subjects: [member, coop], parties: [member, coop] }),
        ),
        { purpose: 'market_intelligence' },
      ),
    );

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'member_body_with_grant');
    assert.equal(decision.grants.length, members.length);
  });
});
