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
import { consentGrantServiceFor } from '../helpers/fixtures.js';

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
