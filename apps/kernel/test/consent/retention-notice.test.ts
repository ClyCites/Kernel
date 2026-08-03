import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import { retentionNoticeServiceFor } from '../helpers/fixtures.js';
import { RetentionNoticeService } from '../../src/consent/retention-notice.service.js';

let db: TestDatabase;
let notices: RetentionNoticeService;

const FARMER = uuidv7();
const COOP = uuidv7();
const RIVAL = uuidv7();

const MARCH = '2026-03-04T09:00:00+03:00';
const JUNE = '2026-06-18T09:00:00+03:00';

const give = (
  party: string,
  givenAt: string,
  text: string,
  period: string,
  givenBy: string | null = COOP,
) =>
  notices.give({
    party,
    noticeText: text,
    periodStated: period,
    lawfulBasis: 'consent',
    purposes: ['membership_administration'],
    language: 'lug',
    givenVia: 'in_person_reading',
    givenBy,
    givenAt,
    dataset: 'live',
  });

before(async () => {
  db = await startTestDatabase();
  notices = retentionNoticeServiceFor(db.app);
});

after(async () => {
  await db.stop();
});

describe('the retention notice actually given, s.13(1)(i)', () => {
  test('the notice is stored as it was given, not as a template id', async () => {
    const row = await give(
      FARMER,
      MARCH,
      'Tunaakuuma ebiwandiiko byo okumala emyaka esatu oluvannyuma lw’okutuusa kwo okusembayo.',
      'three years after your last delivery',
    );

    // The wording is the evidence. A template id points at a document that
    // can itself be edited, which would make the notice unprovable.
    assert.match(row.notice_text, /emyaka esatu/);
    assert.equal(row.period_stated, 'three years after your last delivery');
    assert.equal(row.language, 'lug');
    assert.equal(row.given_via, 'in_person_reading');
    assert.equal(row.given_by, COOP);
    // Text, not a Date. A field that is string at compile time and Date at
    // runtime is how a comparison silently becomes NaN.
    assert.equal(typeof row.given_at, 'string');
  });

  test('a policy changed in June is not what a farmer was told in March', async () => {
    await give(FARMER, JUNE, 'A new and shorter notice.', 'eighteen months');

    const atEnrolment = await notices.inForce(FARMER, MARCH, 'live');
    assert.equal(
      atEnrolment?.period_stated,
      'three years after your last delivery',
      'the March enrolment must still resolve to the March notice',
    );

    const now = await notices.inForce(FARMER, '2026-08-01T00:00:00Z', 'live');
    assert.equal(now?.period_stated, 'eighteen months');

    // Both survive. This is the whole reason the table exists.
    const history = await notices.history(FARMER, 'live');
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((row) => row.period_stated),
      ['eighteen months', 'three years after your last delivery'],
    );
  });

  test('nothing was told to a party before anyone told them anything', async () => {
    const before = await notices.inForce(FARMER, '2026-01-01T00:00:00Z', 'live');
    assert.equal(
      before,
      null,
      'a notice cannot govern a moment before it was given',
    );
  });

  test('a notice cannot be edited or deleted, including by the owner', async () => {
    const row = await give(RIVAL, MARCH, 'Given once.', 'two seasons');

    // The owner, not the app role. `kernel_app` has no UPDATE grant at all, so
    // asserting through it would prove the grant and say nothing about the
    // trigger — and the trigger is what stops the one role that could.
    await assert.rejects(
      db.owner.query(
        'update kernel.retention_notice set period_stated = $1 where id = $2',
        ['forever', row.id],
      ),
      /is refused/i,
    );

    await assert.rejects(
      db.owner.query('delete from kernel.retention_notice where id = $1', [row.id]),
      /is refused/i,
    );

    const still = await notices.history(RIVAL, 'live');
    assert.equal(still[0]?.period_stated, 'two seasons');
  });

  test('an empty period is not a notice', async () => {
    await assert.rejects(
      give(uuidv7(), MARCH, 'Some text.', '   '),
      /retention_notice_period_present/,
    );

    await assert.rejects(
      give(uuidv7(), MARCH, '  ', 'two seasons'),
      /retention_notice_text_present/,
    );
  });

  test('nothing in the kernel acts on the period it records', async () => {
    // D3 is unresolved: the lawful period comes from the 2021 Regulations read
    // with statutes nobody has reconciled yet. A job deleting records on a
    // period we cannot justify is the one mistake here that cannot be undone,
    // so no such job exists and this test exists to notice if one appears.
    const service = RetentionNoticeService.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const name of Object.getOwnPropertyNames(service)) {
      assert.doesNotMatch(
        name,
        /expire|purge|delete|sweep|enforce/i,
        `${name} looks like an expiry job; the period is unresolved (D3)`,
      );
    }
  });
});
