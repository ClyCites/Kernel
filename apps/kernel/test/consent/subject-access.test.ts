import { InferenceRepository } from '../../src/inference/inference.repository.js';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from '@clycites/schema';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  auditServiceFor,
  consentGrantServiceFor,
  consentServiceFor,
  deliveryDocument,
  entityDocument,
  ingestServiceFor,
  objectionServiceFor,
  readingAs,
  subjectAccessServiceFor,
  type TestIngest,
} from '../helpers/fixtures.js';
import { ReadService, type Reader } from '../../src/records/read.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import {
  RESPONSE_DAYS,
  SubjectAccessService,
} from '../../src/consent/subject-access.service.js';

let db: TestDatabase;
let ingest: TestIngest;
let repository: RecordRepository;
let read: ReadService;
let access: SubjectAccessService;

const FARMER = uuidv7();
const NEIGHBOUR = uuidv7();
const COOP = uuidv7();
const BUYER = uuidv7();

before(async () => {
  db = await startTestDatabase();
  ({ ingest, repository } = ingestServiceFor(db.app));
  access = subjectAccessServiceFor(db.app);
  read = new ReadService(
    repository,
    consentServiceFor(db.app),
    objectionServiceFor(db.app),
    auditServiceFor(db.app),
    new InferenceRepository(db.app),
  );

  // Who is a person and who is not. s.24(4) turns on it, so it cannot be
  // assumed either way.
  for (const [id, kind] of [
    [FARMER, 'person'],
    [NEIGHBOUR, 'person'],
    [COOP, 'cooperative'],
    [BUYER, 'business'],
  ] as const) {
    await ingest.ingest(entityDocument('party', { id, kind, asserted_by: COOP }));
  }
});

after(async () => {
  await db.stop();
});

describe('s.24(1): what is held, and the confirmation that something is', () => {
  test('a subject with nothing held is told so rather than refused', async () => {
    const stranger = uuidv7();
    const response = await access.assemble(stranger, 'live');

    assert.equal(response.held, false);
    assert.deepEqual(response.records, []);
    assert.equal(response.subject, stranger);
  });

  test('records about the subject come back whatever field name they use', async () => {
    const holder = uuidv7();
    await ingest.ingest(
      entityDocument('plot', { held_by: holder, asserted_by: COOP }),
    );

    const response = await access.assemble(holder, 'live');
    assert.equal(response.held, true);
    assert.ok(response.records.some((record) => record.type === 'plot'));
  });

  test('a retracted record is still held and still answered for', async () => {
    const holder = uuidv7();
    const { record } = await ingest.ingest(
      entityDocument('plot', { held_by: holder, asserted_by: COOP }),
    );
    await ingest.ingest({
      id: uuidv7(),
      type: 'retraction',
      record_class: 'observation',
      schema_version: SCHEMA_VERSION,
      occurred_at: '2026-07-20T09:00:00+03:00',
      occurred_at_precision: 'day',
      asserted_by: COOP,
      target: record.id,
      reason_code: 'test_entry',
    });

    const response = await access.assemble(holder, 'live');
    const found = response.records.find((row) => row.id === record.id);
    assert.notEqual(found, undefined);
    assert.equal(found?.retracted, true);
  });

  test('the ground each record was collected on is named', async () => {
    const holder = uuidv7();
    await ingest.ingest(
      entityDocument('plot', { held_by: holder, asserted_by: COOP }),
      { lawfulBasis: 'contract_performance' },
    );

    const response = await access.assemble(holder, 'live');
    assert.equal(response.records[0]?.lawful_basis, 'contract_performance');
  });

  test('the thirty-day clock is in the response, not only in the statute', async () => {
    const response = await access.assemble(uuidv7(), 'live');

    const prepared = Date.parse(response.prepared_at);
    const due = Date.parse(response.due_by);
    assert.equal(due - prepared, RESPONSE_DAYS * 86_400_000);
  });
});

describe('s.24(4) and (7): redact, do not refuse', () => {
  let deliveryId: string;

  before(async () => {
    const { record } = await ingest.ingest(
      deliveryDocument({
        from_party: FARMER,
        to_party: NEIGHBOUR,
        asserted_by: COOP,
      }),
    );
    deliveryId = record.id;
  });

  test('the record is returned rather than withheld whole', async () => {
    const response = await access.assemble(FARMER, 'live');

    const delivery = response.records.find((row) => row.id === deliveryId);
    assert.notEqual(delivery, undefined);
    assert.equal(delivery?.document['from_party'], FARMER);
  });

  test('another individual’s particulars are blanked', async () => {
    const response = await access.assemble(FARMER, 'live');

    const delivery = response.records.find((row) => row.id === deliveryId);
    assert.equal(delivery?.document['to_party'], '[redacted]');
    assert.ok(delivery?.redacted.includes('to_party'));
  });

  test('an organisation is not redacted', async () => {
    // s.24(4) protects another individual. A farmer who cannot see which
    // cooperative received their maize cannot dispute the weight.
    const { record } = await ingest.ingest(
      deliveryDocument({ from_party: FARMER, to_party: BUYER, asserted_by: COOP }),
    );

    const response = await access.assemble(FARMER, 'live');
    const delivery = response.records.find((row) => row.id === record.id);
    assert.equal(delivery?.document['to_party'], BUYER);
    assert.deepEqual(delivery?.redacted, []);
  });

  test('the neighbour sees the mirror image of the same record', async () => {
    const response = await access.assemble(NEIGHBOUR, 'live');

    const delivery = response.records.find((row) => row.id === deliveryId);
    assert.equal(delivery?.document['to_party'], NEIGHBOUR);
    assert.equal(delivery?.document['from_party'], '[redacted]');
  });

  test('the response says what redaction means', async () => {
    const response = await access.assemble(FARMER, 'live');
    const notice = response.notice.join(' ');

    assert.match(notice, /s\.24\(4\)/);
    assert.match(notice, /rather than refusing/);
    assert.match(notice, /Organisations are not redacted/);
  });
});

describe('s.24(1)(c): who has had access', () => {
  const HOLDER = uuidv7();
  const GRANTEE = uuidv7();
  let plotId: string;

  const grantee = (): Reader => ({
    requester: GRANTEE,
    purpose: 'advisory',
    dataset: 'live',
  });

  before(async () => {
    const { record } = await ingest.ingest(
      entityDocument('plot', { held_by: HOLDER, asserted_by: COOP }),
    );
    plotId = record.id;

    await consentGrantServiceFor(db.app).grant({
      subject: HOLDER,
      grantee: GRANTEE,
      purpose: 'advisory',
      recordTypes: ['plot'],
      expiresAt: null,
      grantedVia: 'in_person_signature',
      evidence: [],
      dataset: 'live',
    });

    await read.get(plotId, grantee());
  });

  test('the third party who read it is named', async () => {
    const response = await access.assemble(HOLDER, 'live');

    const disclosure = response.disclosures.find((row) => row.actor === GRANTEE);
    assert.notEqual(disclosure, undefined);
    assert.ok(disclosure?.records.includes(plotId));
  });

  test('the permission that was leaned on is named too', async () => {
    // "Somebody read it" is not much of an answer. Whether they read it on a
    // grant the subject gave or on membership they never agreed to is the
    // part a subject would act on.
    const response = await access.assemble(HOLDER, 'live');

    const disclosure = response.disclosures.find((row) => row.actor === GRANTEE);
    assert.equal(disclosure?.purpose, 'advisory');
    assert.equal(typeof disclosure?.access, 'string');
  });

  test('the subject’s own reads are not listed as disclosures', async () => {
    await read.get(plotId, readingAs(HOLDER));

    const response = await access.assemble(HOLDER, 'live');
    assert.equal(
      response.disclosures.some((row) => row.actor === HOLDER),
      false,
    );
  });

  test('a refused read is not a disclosure', async () => {
    const refused = uuidv7();
    await read.get(plotId, readingAs(refused)).catch(() => null);

    const response = await access.assemble(HOLDER, 'live');
    assert.equal(
      response.disclosures.some((row) => row.actor === refused),
      false,
    );
  });

  test('the application cannot read the log any other way', async () => {
    // 0017 gave kernel_app INSERT and nothing else. The definer function in
    // 0023 is the whole of the exception, and this is what keeps it so.
    const error = await db.app
      .query('select * from audit.entry limit 1')
      .then(() => null, (caught: unknown) => caught);

    assert.notEqual(error, null);
  });
});

describe('the other rights are part of the answer', () => {
  const HOLDER = uuidv7();

  before(async () => {
    await ingest.ingest(
      entityDocument('plot', { held_by: HOLDER, asserted_by: COOP }),
    );
    await consentGrantServiceFor(db.app).grant({
      subject: HOLDER,
      grantee: uuidv7(),
      purpose: 'credit_assessment',
      recordTypes: ['plot'],
      expiresAt: null,
      grantedVia: 'in_person_signature',
      evidence: [],
      dataset: 'live',
    });
    await objectionServiceFor(db.app).lodge({
      subject: HOLDER,
      scope: null,
      lodgedVia: 'in_person',
      lodgedBy: HOLDER,
      delegation: null,
      evidence: [],
      dataset: 'live',
    });
  });

  test('grants the subject has given are listed', async () => {
    const response = await access.assemble(HOLDER, 'live');
    assert.equal(response.consents.length, 1);
    assert.equal(response.consents[0]?.purpose, 'credit_assessment');
  });

  test('objections the subject has lodged are listed', async () => {
    const response = await access.assemble(HOLDER, 'live');
    assert.equal(response.objections.length, 1);
  });

  test('an objection does not empty the subject’s own answer', async () => {
    // The carve-out in 0030, seen from the other side: a farmer who objects
    // and then asks what is held must not be told "nothing".
    const response = await access.assemble(HOLDER, 'live');
    assert.equal(response.held, true);
  });
});

describe('the request is itself recorded', () => {
  test('an access request appears in the audit log', async () => {
    const holder = uuidv7();
    await ingest.ingest(
      entityDocument('plot', { held_by: holder, asserted_by: COOP }),
    );
    await access.assemble(holder, 'live');

    const { rows } = await db.owner.query<{ entries: string }>(
      `select count(*) as entries from audit.entry
        where reason = 'subject_access' and actor = $1`,
      [holder],
    );
    assert.equal(rows[0]?.entries, '1');
  });

  test('latency is measured, because thirty days is a deadline', async () => {
    const before = access.latency().requests;
    await access.assemble(uuidv7(), 'live');

    assert.equal(access.latency().requests, before + 1);
  });
});
