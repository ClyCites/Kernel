import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import {
  INSUFFICIENT_PRIVILEGE,
  RESTRICT_VIOLATION,
  sqlState,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import {
  consentGrantServiceFor,
  objectionServiceFor,
} from '../helpers/fixtures.js';

let db: TestDatabase;
let id: string;

const SUBJECT = uuidv7();
const GRANTEE = uuidv7();

before(async () => {
  db = await startTestDatabase();
  const row = await consentGrantServiceFor(db.app).grant({
    subject: SUBJECT,
    grantee: GRANTEE,
    purpose: 'credit_assessment',
    recordTypes: ['delivery'],
    expiresAt: null,
    grantedVia: 'in_person_signature',
    evidence: [],
    dataset: 'live',
  });
  id = row.id;
});

after(async () => {
  await db.stop();
});

/**
 * A consent record that could be edited is not evidence of anything.
 *
 * The whole point of withdrawal being an insert is that the original grant
 * survives it: a subject who withdraws in August must still be able to show
 * that they had consented in July, and a regulator asking why data was
 * disclosed then needs the grant to still be there. An UPDATE would let both
 * facts be replaced by whichever one suits later.
 */
describe('the consent store is append-only', () => {
  test('the application role cannot update a grant', async () => {
    const error = await db.app
      .query(`update kernel.consent_grant set purpose = 'advisory' where id = $1`, [id])
      .then(() => null, (caught: unknown) => caught);

    assert.notEqual(error, null);
    assert.ok(
      [INSUFFICIENT_PRIVILEGE, RESTRICT_VIOLATION].includes(sqlState(error) ?? ''),
      `expected a refusal, got ${sqlState(error)}`,
    );
  });

  test('the application role cannot delete a grant', async () => {
    const error = await db.app
      .query('delete from kernel.consent_grant where id = $1', [id])
      .then(() => null, (caught: unknown) => caught);

    assert.notEqual(error, null);
    assert.ok(
      [INSUFFICIENT_PRIVILEGE, RESTRICT_VIOLATION].includes(sqlState(error) ?? ''),
      `expected a refusal, got ${sqlState(error)}`,
    );
  });

  test('even the owner is stopped by the trigger', async () => {
    const error = await db.owner
      .query(`update kernel.consent_grant set purpose = 'advisory' where id = $1`, [id])
      .then(() => null, (caught: unknown) => caught);

    assert.equal(sqlState(error), RESTRICT_VIOLATION);
  });

  test('a revocation cannot be withdrawn either', async () => {
    await consentGrantServiceFor(db.app).revoke(id, SUBJECT, null, 'live');

    const error = await db.owner
      .query('delete from kernel.consent_revocation where grant_id = $1', [id])
      .then(() => null, (caught: unknown) => caught);

    assert.equal(sqlState(error), RESTRICT_VIOLATION);
  });

  test('a second withdrawal does not pad the history', async () => {
    await consentGrantServiceFor(db.app).revoke(id, SUBJECT, 'again', 'live');

    const { rows } = await db.app.query<{ count: string }>(
      'select count(*)::text as count from kernel.consent_revocation where grant_id = $1',
      [id],
    );
    assert.equal(rows[0]?.count, '1');
  });
});

/**
 * The same reasoning, and one addition: an objection that could be edited is
 * a protection somebody else can quietly remove.
 */
describe('the objection store is append-only', () => {
  let objection: string;

  before(async () => {
    const outcome = await objectionServiceFor(db.app).lodge({
      subject: SUBJECT,
      scope: null,
      lodgedVia: 'in_person',
      lodgedBy: SUBJECT,
      delegation: null,
      evidence: [],
      dataset: 'live',
    });
    objection = outcome.objection.id;
  });

  test('the application role cannot delete an objection', async () => {
    const error = await db.app
      .query('delete from kernel.objection where id = $1', [objection])
      .then(() => null, (caught: unknown) => caught);

    assert.notEqual(error, null);
    assert.ok(
      [INSUFFICIENT_PRIVILEGE, RESTRICT_VIOLATION].includes(sqlState(error) ?? ''),
      `expected a refusal, got ${sqlState(error)}`,
    );
  });

  test('even the owner cannot narrow its scope after the fact', async () => {
    const error = await db.owner
      .query(`update kernel.objection set scope = '{delivery}' where id = $1`, [
        objection,
      ])
      .then(() => null, (caught: unknown) => caught);

    assert.equal(sqlState(error), RESTRICT_VIOLATION);
  });

  test('a withdrawal cannot itself be withdrawn', async () => {
    await objectionServiceFor(db.app).withdraw(
      objection,
      SUBJECT,
      'in_person',
      null,
      'live',
    );

    const error = await db.owner
      .query('delete from kernel.objection_withdrawal where objection_id = $1', [
        objection,
      ])
      .then(() => null, (caught: unknown) => caught);

    assert.equal(sqlState(error), RESTRICT_VIOLATION);
  });

  test('ussd is not evidence enough to withdraw one', async () => {
    const error = await db.owner
      .query(
        `insert into kernel.objection_withdrawal
           (id, objection_id, withdrawn_at, withdrawn_by, withdrawn_via)
         values ($1, $2, now(), $3, 'ussd_confirmation')`,
        [uuidv7(), objection, SUBJECT],
      )
      .then(() => null, (caught: unknown) => caught);

    assert.notEqual(error, null);
  });
});

/**
 * The one store in this schema with a nullable column that gets filled in.
 *
 * Every other change of state here is a second row, and 0024 explains why this
 * one is not: a delivery receipt with no obligation behind it is not a thing
 * that can exist. What has to survive that exception is the property the rule
 * was protecting — that nothing already written can be altered or removed.
 */
describe('a disclosure notification is write-once', () => {
  const RECORD = uuidv7();
  const CORRECTION = uuidv7();
  const RECIPIENT = uuidv7();
  let notification: string;

  before(async () => {
    const { rows } = await db.app.query<{ id: string }>(
      `insert into kernel.disclosure_notification
         (id, record_id, correction_id, recipient)
       values ($1, $2, $3, $4) returning id`,
      [uuidv7(), RECORD, CORRECTION, RECIPIENT],
    );
    notification = rows[0]?.id ?? '';
  });

  test('the application role cannot delete one', async () => {
    const error = await db.app
      .query('delete from kernel.disclosure_notification where id = $1', [
        notification,
      ])
      .then(() => null, (caught: unknown) => caught);

    assert.notEqual(error, null);
    assert.ok(
      [INSUFFICIENT_PRIVILEGE, RESTRICT_VIOLATION].includes(sqlState(error) ?? ''),
      `expected a refusal, got ${sqlState(error)}`,
    );
  });

  test('even the owner cannot delete one', async () => {
    const error = await db.owner
      .query('delete from kernel.disclosure_notification where id = $1', [
        notification,
      ])
      .then(() => null, (caught: unknown) => caught);

    assert.equal(sqlState(error), RESTRICT_VIOLATION);
  });

  test('who was owed what cannot be moved to somebody else', async () => {
    const error = await db.owner
      .query('update kernel.disclosure_notification set recipient = $2 where id = $1', [
        notification,
        uuidv7(),
      ])
      .then(() => null, (caught: unknown) => caught);

    assert.equal(sqlState(error), RESTRICT_VIOLATION);
  });

  test('delivery is recorded once and cannot be rewritten', async () => {
    await db.app.query(
      `update kernel.disclosure_notification
          set delivered_at = now(), channel = 'sms' where id = $1`,
      [notification],
    );

    const error = await db.owner
      .query(
        `update kernel.disclosure_notification
            set delivered_at = now(), channel = 'email' where id = $1`,
        [notification],
      )
      .then(() => null, (caught: unknown) => caught);

    assert.equal(sqlState(error), RESTRICT_VIOLATION);
  });

  test('a delivery without a channel is not a delivery record', async () => {
    const { rows } = await db.app.query<{ id: string }>(
      `insert into kernel.disclosure_notification
         (id, record_id, correction_id, recipient)
       values ($1, $2, $3, $4) returning id`,
      [uuidv7(), RECORD, CORRECTION, uuidv7()],
    );

    const error = await db.app
      .query(
        'update kernel.disclosure_notification set delivered_at = now() where id = $1',
        [rows[0]?.id],
      )
      .then(() => null, (caught: unknown) => caught);

    assert.notEqual(error, null);
  });
});
