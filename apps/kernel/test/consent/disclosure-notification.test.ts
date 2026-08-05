import { InferenceRepository } from '../../src/inference/inference.repository.js';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  auditServiceFor,
  consentGrantServiceFor,
  consentServiceFor,
  entityDocument,
  ingestServiceFor,
  objectionServiceFor,
  readingAs,
  retractionDocument,
  subjectAccessServiceFor,
  anchorServiceFor,
  type TestIngest,
} from '../helpers/fixtures.js';
import { OperationsController } from '../../src/api/operations.controller.js';
import { DisclosureNotificationRepository } from '../../src/consent/disclosure-notification.repository.js';
import { ObjectionRepository } from '../../src/consent/objection.repository.js';
import { ReadService, type Reader } from '../../src/records/read.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { RegistryRepository } from '../../src/registry/registry.repository.js';
import type { Dataset } from '../../src/records/record.js';

let db: TestDatabase;
let ingest: TestIngest;
let repository: RecordRepository;
let read: ReadService;
let notifications: DisclosureNotificationRepository;

// Each test uses a fresh holder, so that one test's disclosures cannot leak
// into another's count. The coop asserts all of them.
const COOP = uuidv7();

before(async () => {
  db = await startTestDatabase();
  ({ ingest, repository } = ingestServiceFor(db.app));
  notifications = new DisclosureNotificationRepository(db.app);
  read = new ReadService(
    repository,
    consentServiceFor(db.app),
    objectionServiceFor(db.app),
    auditServiceFor(db.app),
    new InferenceRepository(db.app),
  );
});

after(async () => {
  await db.stop();
});

/** A plot the cooperative asserted about the farmer, in one line. */
const plotOf = async (holder: string, dataset: Dataset = 'live') => {
  const { record } = await ingest.ingest(
    entityDocument('plot', { held_by: holder, asserted_by: COOP }),
    { dataset },
  );
  return record.id;
};

const correctionOf = async (
  plot: string,
  holder: string,
  dataset: Dataset = 'live',
) => {
  const { record } = await ingest.ingest(
    entityDocument('plot', {
      held_by: holder,
      asserted_by: COOP,
      supersedes: plot,
    }),
    { dataset },
  );
  return record.id;
};

/** Someone the subject has actually let in, since consent denies everything else. */
const letIn = async (
  subject: string,
  grantee: string,
  dataset: Dataset = 'live',
): Promise<Reader> => {
  await consentGrantServiceFor(db.app).grant({
    subject,
    grantee,
    purpose: 'advisory',
    recordTypes: ['plot'],
    expiresAt: null,
    grantedVia: 'in_person_signature',
    evidence: [],
    dataset,
  });
  return { requester: grantee, purpose: 'advisory', dataset };
};

describe('s.16(4): the parties who received the old version are told', () => {
  test('every third party who read it is owed a notification', async () => {
    const holder = uuidv7();
    const lender = uuidv7();
    const buyer = uuidv7();
    const plot = await plotOf(holder);

    await read.get(plot, await letIn(holder, lender));
    await read.get(plot, await letIn(holder, buyer));

    const correction = await correctionOf(plot, holder);

    const raised = await notifications.forRecord(plot, 'live');
    assert.deepEqual(
      raised.map((row) => row.recipient).sort(),
      [lender, buyer].sort(),
    );
    assert.ok(raised.every((row) => row.correction_id === correction));
    assert.ok(raised.every((row) => row.delivered_at === null));
  });

  test('reading it twice still owes one notification', async () => {
    const holder = uuidv7();
    const lender = uuidv7();
    const plot = await plotOf(holder);
    const reader = await letIn(holder, lender);

    await read.get(plot, reader);
    await read.get(plot, reader);
    await correctionOf(plot, holder);

    const raised = await notifications.forRecord(plot, 'live');
    assert.equal(raised.length, 1);
  });

  test('a record nobody else has seen owes nothing', async () => {
    const holder = uuidv7();
    const plot = await plotOf(holder);

    await correctionOf(plot, holder);

    assert.deepEqual(await notifications.forRecord(plot, 'live'), []);
  });

  test('a retraction owes them too', async () => {
    // s.16(4) covers deletion as well as correction, and in a log that never
    // deletes, retraction is what deletion is.
    const holder = uuidv7();
    const lender = uuidv7();
    const plot = await plotOf(holder);

    await read.get(plot, await letIn(holder, lender));
    const { record } = await ingest.ingest(
      retractionDocument(plot, { asserted_by: COOP }),
    );

    const raised = await notifications.forRecord(plot, 'live');
    assert.equal(raised.length, 1);
    assert.equal(raised[0]?.recipient, lender);
    assert.equal(raised[0]?.correction_id, record.id);
  });

  test('a correction that is replayed does not owe a second one', async () => {
    const holder = uuidv7();
    const lender = uuidv7();
    const plot = await plotOf(holder);
    await read.get(plot, await letIn(holder, lender));

    const document = entityDocument('plot', {
      held_by: holder,
      asserted_by: COOP,
      supersedes: plot,
    });
    await ingest.ingest(document);
    await ingest.ingest(document);

    assert.equal((await notifications.forRecord(plot, 'live')).length, 1);
  });
});

describe('what is not a disclosure', () => {
  test('a refused read owes nothing', async () => {
    const holder = uuidv7();
    const stranger = uuidv7();
    const plot = await plotOf(holder);

    await read.get(plot, readingAs(stranger)).catch(() => null);
    await correctionOf(plot, holder);

    assert.deepEqual(await notifications.forRecord(plot, 'live'), []);
  });

  test('the subject reading their own record owes nothing', async () => {
    const holder = uuidv7();
    const plot = await plotOf(holder);

    await read.get(plot, readingAs(holder));
    await correctionOf(plot, holder);

    assert.deepEqual(await notifications.forRecord(plot, 'live'), []);
  });

  test('the party who asserted it owes nothing', async () => {
    const holder = uuidv7();
    const plot = await plotOf(holder);

    await read.get(plot, readingAs(COOP));
    await correctionOf(plot, holder);

    assert.deepEqual(await notifications.forRecord(plot, 'live'), []);
  });

  test('a seed disclosure never produces a live notification', async () => {
    // 0011. Seed traffic must not surface anywhere a real obligation is
    // counted, and the discriminator is carried per audit entry so that this
    // is checked rather than inferred from the ids involved.
    const holder = uuidv7();
    const lender = uuidv7();
    const plot = await plotOf(holder, 'seed');

    await read.get(plot, await letIn(holder, lender, 'seed'));
    await correctionOf(plot, holder, 'seed');

    assert.deepEqual(await notifications.forRecord(plot, 'live'), []);
    assert.equal((await notifications.forRecord(plot, 'seed')).length, 1);
  });
});

describe('a record corrected twice', () => {
  test('owes one notification, because the second correction replaced a version nobody received', async () => {
    const holder = uuidv7();
    const lender = uuidv7();
    const plot = await plotOf(holder);

    await read.get(plot, await letIn(holder, lender));
    const first = await correctionOf(plot, holder);
    await correctionOf(first, holder);

    assert.equal((await notifications.forRecord(plot, 'live')).length, 1);
    assert.deepEqual(await notifications.forRecord(first, 'live'), []);
  });

  test('owes a second one if they read the corrected version too', async () => {
    const holder = uuidv7();
    const lender = uuidv7();
    const plot = await plotOf(holder);
    const reader = await letIn(holder, lender);

    await read.get(plot, reader);
    const first = await correctionOf(plot, holder);
    await read.get(first, reader);
    await correctionOf(first, holder);

    assert.equal((await notifications.forRecord(plot, 'live')).length, 1);
    assert.equal((await notifications.forRecord(first, 'live')).length, 1);
  });
});

describe('the obligation is countable while it is outstanding', () => {
  let operations: OperationsController;

  before(() => {
    operations = new OperationsController(
      db.app,
      new RegistryRepository(db.app),
      repository,
      new ObjectionRepository(db.app),
      subjectAccessServiceFor(db.app),
      notifications,
      anchorServiceFor(db.app),
    );
  });

  const gauge = (metrics: string, name: string): number =>
    Number(new RegExp(`^${name} (\\S+)$`, 'm').exec(metrics)?.[1] ?? NaN);

  test('an undelivered notification is on /metrics', async () => {
    const before = gauge(
      await operations.metrics(),
      'kernel_disclosure_notifications_outstanding',
    );

    const holder = uuidv7();
    const plot = await plotOf(holder);
    await read.get(plot, await letIn(holder, uuidv7()));
    await correctionOf(plot, holder);

    assert.equal(
      gauge(await operations.metrics(), 'kernel_disclosure_notifications_outstanding'),
      before + 1,
    );
  });

  test('the age of the oldest one is on /metrics too', async () => {
    // One notification outstanding for a month is a worse breach than fifty
    // raised this hour, and a count alone cannot tell them apart.
    const metrics = await operations.metrics();

    assert.ok(
      metrics.includes('# TYPE kernel_disclosure_notification_oldest_seconds gauge'),
    );
    assert.ok(gauge(metrics, 'kernel_disclosure_notification_oldest_seconds') >= 0);
  });

  test('recording delivery takes it off the count', async () => {
    const holder = uuidv7();
    const lender = uuidv7();
    const plot = await plotOf(holder);
    await read.get(plot, await letIn(holder, lender));
    await correctionOf(plot, holder);

    const raised = await notifications.forRecord(plot, 'live');
    const before = gauge(
      await operations.metrics(),
      'kernel_disclosure_notifications_outstanding',
    );

    const delivered = await notifications.markDelivered(
      raised[0]?.id ?? '',
      'sms',
      new Date().toISOString(),
    );

    assert.equal(delivered?.channel, 'sms');
    assert.equal(
      gauge(await operations.metrics(), 'kernel_disclosure_notifications_outstanding'),
      before - 1,
    );
  });

  test('a second delivery report is refused rather than believed', async () => {
    const holder = uuidv7();
    const plot = await plotOf(holder);
    await read.get(plot, await letIn(holder, uuidv7()));
    await correctionOf(plot, holder);

    const raised = await notifications.forRecord(plot, 'live');
    const id = raised[0]?.id ?? '';
    await notifications.markDelivered(id, 'sms', new Date().toISOString());

    assert.equal(
      await notifications.markDelivered(id, 'email', new Date().toISOString()),
      null,
    );
  });
});

describe('the log is still not readable', () => {
  test('the application cannot select from audit.entry to answer this', async () => {
    // 0024 is a second definer function, not a second grant. If this starts
    // passing, the reason 0017 gave kernel_app INSERT and nothing else has
    // been undone somewhere.
    const error = await db.app
      .query('select records from audit.entry limit 1')
      .then(() => null, (caught: unknown) => caught);

    assert.notEqual(error, null);
  });
});
