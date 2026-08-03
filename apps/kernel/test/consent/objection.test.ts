import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  auditServiceFor,
  consentServiceFor,
  entityDocument,
  ingestServiceFor,
  objectionServiceFor,
  readingAs,
  type TestIngest,
} from '../helpers/fixtures.js';
import { ObjectionService } from '../../src/consent/objection.service.js';
import { ReadService } from '../../src/records/read.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';

let db: TestDatabase;
let ingest: TestIngest;
let repository: RecordRepository;
let read: ReadService;
let objections: ObjectionService;

const FARMER = uuidv7();
const COOP = uuidv7();
const OFFICER = uuidv7();


before(async () => {
  db = await startTestDatabase();
  ({ ingest, repository } = ingestServiceFor(db.app));
  objections = objectionServiceFor(db.app);
  read = new ReadService(
    repository,
    consentServiceFor(db.app),
    objections,
    auditServiceFor(db.app),
  );

  // Asserted by the cooperative, about the farmer. The ordinary shape, and
  // the one that makes "whose processing stops" a real question. These two
  // are reached through the basis census rather than by id: what the suite
  // below asks is which ground stopped, not which row.

  // Held on consent, so s.7(3) reaches it.
  await ingest.ingest(
    entityDocument('plot', { held_by: FARMER, asserted_by: COOP }),
    { lawfulBasis: 'consent' },
  );

  // Held on a s.7(2) ground, so it does not.
  await ingest.ingest(
    entityDocument('plot', { held_by: FARMER, asserted_by: COOP }),
    { lawfulBasis: 'contract_performance' },
  );
});

after(async () => {
  await db.stop();
});

const lodging = (overrides: Record<string, unknown> = {}) => ({
  subject: FARMER,
  scope: null,
  lodgedVia: 'in_person' as const,
  lodgedBy: FARMER,
  delegation: null,
  evidence: [],
  dataset: 'live' as const,
  ...overrides,
});

describe('an objection resolves against the ground, not the record', () => {
  test('it stops processing of a record held on consent', async () => {
    const outcome = await objections.lodge(lodging());

    const stopped = outcome.stopped.find(
      (row) => row.record_type === 'plot' && row.lawful_basis === 'consent',
    );
    assert.notEqual(stopped, undefined);
    assert.ok((stopped?.records ?? 0) >= 1);
  });

  test('it leaves a s.7(2) record processing, and names the ground', async () => {
    const outcome = await objections.lodge(lodging());

    const continuing = outcome.continuing.find(
      (row) => row.lawful_basis === 'contract_performance',
    );
    assert.notEqual(continuing, undefined);
    assert.match(continuing?.ground ?? '', /s\.7\(2\)/);
    assert.match(continuing?.ground ?? '', /contract_performance/);
  });

  test('the response enumerates both sets rather than answering yes', async () => {
    const outcome = await objections.lodge(lodging());

    assert.ok(outcome.stopped.length > 0);
    assert.ok(outcome.continuing.length > 0);
    // A boolean here would be the failure this test exists to prevent: a
    // subject told "done" while a cooperative carries on under another ground.
    for (const row of [...outcome.stopped, ...outcome.continuing]) {
      assert.equal(typeof row.record_type, 'string');
      assert.equal(typeof row.lawful_basis, 'string');
    }
    for (const row of outcome.continuing) {
      assert.equal(typeof row.ground, 'string');
    }
  });

  test('a scoped objection leaves everything else running, and says why', async () => {
    const outcome = await objections.lodge(lodging({ scope: ['delivery'] }));

    assert.deepEqual(outcome.stopped, []);
    const plot = outcome.continuing.find((row) => row.record_type === 'plot');
    assert.match(plot?.ground ?? '', /outside the scope/);
  });

  test('the response says what an objection is not', async () => {
    const outcome = await objections.lodge(lodging());

    const notice = outcome.notice.join(' ');
    assert.match(notice, /not erasure/);
    assert.match(notice, /disclosures already made/);
    assert.match(notice, /audit log/);
    assert.match(notice, /own record of a transaction/);
  });
});

describe('lodging may be delegated; withdrawing may not', () => {
  test('an officer may lodge for a farmer', async () => {
    const outcome = await objections.lodge(
      lodging({ lodgedBy: OFFICER, delegation: uuidv7() }),
    );

    assert.equal(outcome.objection.subject, FARMER);
    assert.equal(outcome.objection.lodged_by, OFFICER);
  });

  test('lodging for another party without naming the delegation is refused', async () => {
    await assert.rejects(
      objections.lodge(lodging({ lodgedBy: OFFICER })),
      /delegation/,
    );
  });

  test('the same officer may not withdraw it', async () => {
    const outcome = await objections.lodge(
      lodging({ lodgedBy: OFFICER, delegation: uuidv7() }),
    );

    const withdrawn = await objections.withdraw(
      outcome.objection.id,
      OFFICER,
      'in_person',
      null,
      'live',
    );

    assert.equal(withdrawn, null);
    const [standing] = await objections.standing(FARMER, 'live');
    assert.equal(standing?.withdrawn_at ?? null, null);
  });

  test('the subject may withdraw it themselves', async () => {
    const outcome = await objections.lodge(lodging());

    const withdrawn = await objections.withdraw(
      outcome.objection.id,
      FARMER,
      'in_person',
      null,
      'live',
    );

    assert.notEqual(withdrawn, null);
    assert.notEqual(withdrawn?.withdrawn_at, null);
  });
});

describe('an objected record is absent from reads', () => {
  const HOLDER = uuidv7();
  let objected: string;

  before(async () => {
    const { record } = await ingest.ingest(
      entityDocument('plot', { held_by: HOLDER, asserted_by: COOP }),
      { lawfulBasis: 'consent' },
    );
    objected = record.id;

    await objections.lodge(lodging({ subject: HOLDER, lodgedBy: HOLDER }));
  });

  test('a default read no longer returns it', async () => {
    assert.equal(await read.get(objected, readingAs(HOLDER)), null);
  });

  test('the cooperative that asserted it keeps its own copy', async () => {
    // s.7(3) stops disclosure, not the cooperative's own processing. A coop
    // cannot be made to forget a transaction it was part of and still keep
    // books.
    const view = await read.get(objected, readingAs(COOP));
    assert.equal(view?.record['id'], objected);
  });

  test('kernel integrity still sees it', async () => {
    // Mass balance, supersession resolution and anchoring read through the
    // repository and never through the guarded read path, so an objection
    // cannot make a lot fail to balance or a chain lose a link.
    const found = await repository.findByIdWithDerived(objected);
    assert.equal(found?.id, objected);
  });

  test('a record on a s.7(2) ground is untouched by the same objection', async () => {
    const { record } = await ingest.ingest(
      entityDocument('plot', { held_by: HOLDER, asserted_by: COOP }),
      { lawfulBasis: 'contract_performance' },
    );

    const view = await read.get(record.id, readingAs(HOLDER));
    assert.equal(view?.record['id'], record.id);
  });

  test('withdrawing the objection brings it back', async () => {
    const [standing] = await objections.standing(HOLDER, 'live');
    assert.notEqual(standing, undefined);
    await objections.withdraw(
      standing?.id ?? '',
      HOLDER,
      'written',
      null,
      'live',
    );

    const view = await read.get(objected, readingAs(HOLDER));
    assert.equal(view?.record['id'], objected);
  });
});

describe('the audit log is not part of what stops', () => {
  test('the entries about an objected record survive the objection', async () => {
    const holder = uuidv7();
    const { record } = await ingest.ingest(
      entityDocument('plot', { held_by: holder, asserted_by: COOP }),
      { lawfulBasis: 'consent' },
    );

    await read.get(record.id, readingAs(holder));
    const before = await entriesFor(record.id);
    assert.ok(before > 0);

    await objections.lodge(lodging({ subject: holder, lodgedBy: holder }));
    await read.get(record.id, readingAs(holder));

    // s.24(1)(c) is a statutory record of who saw what. An objection that
    // could erase it would destroy the subject's own evidence.
    const after = await entriesFor(record.id);
    assert.ok(after > before);
  });
});

async function entriesFor(recordId: string): Promise<number> {
  const { rows } = await db.owner.query<{ entries: string }>(
    `select count(*) as entries from audit.entry where $1 = any(records)`,
    [recordId],
  );
  return Number(rows[0]?.entries ?? 0);
}
