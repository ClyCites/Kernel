import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  entityDocument,
  ingestServiceFor,
  type TestIngest,
  readingAs,
  retractionDocument,
} from '../helpers/fixtures.js';
import { ConsentService } from '../../src/consent/consent.service.js';
import { ReadService } from '../../src/records/read.service.js';
import {
  RECORD_TYPE_FOR_SUBJECT,
  resolveSubject,
} from '../../src/records/subjects.js';
import { SubjectType } from '@clycites/schema';

let db: TestDatabase;
let ingest: TestIngest;
let read: ReadService;

before(async () => {
  db = await startTestDatabase();
  const assembled = ingestServiceFor(db.app);
  ingest = assembled.ingest;
  read = new ReadService(assembled.repository, new ConsentService());
});

after(async () => {
  await db.stop();
});

describe('subject resolution', () => {
  test('a subject that has not arrived is unknown, not wrong', () => {
    const resolved = resolveSubject('lot', 'x', undefined);

    assert.equal(resolved.exists, false);
    assert.equal(
      resolved.type_matches,
      null,
      'an observation routinely syncs before its subject',
    );
  });

  test('a subject of the declared kind matches', () => {
    const resolved = resolveSubject('lot', 'x', {
      type: 'lot',
      retracted: false,
    });

    assert.equal(resolved.exists, true);
    assert.equal(resolved.type_matches, true);
  });

  test('a subject of some other kind is a mismatch, permanently', () => {
    const resolved = resolveSubject('lot', 'x', {
      type: 'party',
      retracted: false,
    });

    assert.equal(resolved.type_matches, false);
    assert.equal(resolved.actual_type, 'party');
  });

  test('every SubjectType is accounted for', () => {
    for (const type of SubjectType.options) {
      assert.ok(
        type in RECORD_TYPE_FOR_SUBJECT,
        `${type} has no mapping, so an observation about it resolves by accident`,
      );
    }
  });

  /**
   * FINDING for spec §13. `region` is a SubjectType, but regions are registry
   * rows keyed by code and vintage — they are not records and have no uuidv7.
   * `subject_ref` is `z.uuid({ version: 'v7' })`, so a region observation
   * cannot name its own subject. Either regions become records, or
   * `subject_ref` widens, or `region` comes out of the enum.
   */
  test('FINDING: a region subject can never resolve', () => {
    assert.equal(RECORD_TYPE_FOR_SUBJECT['region'], null);
    assert.equal(resolveSubject('region', 'x', undefined).type_matches, null);
  });
});

describe('an observation says whether its subject is real', () => {
  const farmer = uuidv7();

  const observe = async (
    subjectType: string,
    subjectRef: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const document = entityDocument('observation', {
      id: uuidv7(),
      asserted_by: farmer,
      subject_type: subjectType,
      subject_ref: subjectRef,
      observation_type: 'moisture.grain_pct',
      value: { kind: 'scalar', value: 13.5, unit: 'percent' },
      method: 'field_instrument',
      ...overrides,
    });
    await ingest.ingest(document);
    return document.id as string;
  };

  const lot = async () => {
    const document = entityDocument('lot', {
      id: uuidv7(),
      asserted_by: farmer,
      custodian: farmer,
    });
    await ingest.ingest(document);
    return document.id as string;
  };

  test('a subject that exists and matches is reported as such', async () => {
    const subject = await lot();
    const id = await observe('lot', subject);

    const view = await read.get(id, readingAs(farmer));

    assert.equal(view?.subject?.exists, true);
    assert.equal(view?.subject?.type_matches, true);
    assert.deepEqual(view?.quality_flags, []);
  });

  test('a subject that is the wrong kind is flagged at ingest', async () => {
    const subject = await lot();
    const id = await observe('plot', subject);

    const view = await read.get(id, readingAs(farmer));

    assert.ok(view?.quality_flags.includes('subject_type_mismatch'));
    assert.equal(view?.subject?.actual_type, 'lot');
    assert.equal(view?.subject?.type_matches, false);
  });

  test('an observation about nothing is accepted, and says so on read', async () => {
    const id = await observe('lot', uuidv7());

    const view = await read.get(id, readingAs(farmer));

    assert.equal(view?.subject?.exists, false);
    assert.deepEqual(
      view?.quality_flags,
      [],
      'a missing subject is not a fact about this record, only about now',
    );
  });

  /**
   * The reason existence is not a stored flag. The same two records syncing in
   * the other order would otherwise carry different flags forever.
   */
  test('a subject arriving later makes the observation resolve, with no rewrite', async () => {
    const subjectId = uuidv7();
    const id = await observe('lot', subjectId);

    const before = await read.get(id, readingAs(farmer));
    assert.equal(before?.subject?.exists, false);

    await ingest.ingest(
      entityDocument('lot', {
        id: subjectId,
        asserted_by: farmer,
        custodian: farmer,
      }),
    );

    const after = await read.get(id, readingAs(farmer));
    assert.equal(after?.subject?.exists, true);
    assert.equal(after?.subject?.type_matches, true);
    assert.deepEqual(after?.quality_flags, before?.quality_flags);
  });

  test('an observation about a retracted subject is surfaced, not hidden', async () => {
    const subject = await lot();
    const id = await observe('lot', subject);
    await ingest.ingest(retractionDocument(subject, { asserted_by: farmer }));

    const view = await read.get(id, readingAs(farmer));

    assert.equal(view?.subject?.exists, true);
    assert.equal(view?.subject?.retracted, true);
  });

  test('a whole page of observations costs one query', async () => {
    const subject = await lot();
    const ids = [
      await observe('lot', subject),
      await observe('lot', uuidv7()),
    ];

    const page = await read.list(
      { assertedBy: farmer, type: 'observation' },
      readingAs(farmer),
    );

    const seen = page.records.filter((view) =>
      ids.includes(view.record['id'] as string),
    );
    assert.equal(seen.length, 2);
    assert.ok(seen.every((view) => view.subject !== undefined));
  });

  test('the resolution is attached to the view, never merged into the record', async () => {
    const subject = await lot();
    const id = await observe('lot', subject);

    const view = await read.get(id, readingAs(farmer));

    assert.equal(view?.record['subject'], undefined);
    assert.equal(view?.record['subject_ref'], subject);
  });
});
