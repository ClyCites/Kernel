import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  sqlState,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/database.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase();
});

after(async () => {
  await db.stop();
});

/** Raised by kernel.party_link_append_only(). */
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';

/**
 * Work order M3, deferring open decision D2. Decision 0026.
 *
 * The one property everything here defends: **linking is recoverable and
 * merging is not**. A wrong link is withdrawn without touching a record. A
 * wrong merge has attributed one woman's production history to another woman,
 * and the repair is archaeology.
 */

/** Two party ids in a known order, so the ordering constraint is testable. */
function pair(): { low: string; high: string } {
  const [a, b] = [uuidv7(), uuidv7()].sort();
  return { low: a!, high: b! };
}

async function link(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { low, high } = pair();
  const values = {
    id: uuidv7(),
    relation: 'same_as',
    left_party: low,
    right_party: high,
    asserted_by: uuidv7(),
    asserted_at: new Date().toISOString(),
    confidence: 0.8,
    evidence: 'phone_match',
    dataset: 'live',
    lawful_basis: 'contract_performance',
    ...overrides,
  };

  const columns = Object.keys(values);
  const { rows } = await db.owner.query(
    `insert into kernel.party_link (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})
     returning *`,
    Object.values(values),
  );
  return rows[0] as Record<string, unknown>;
}

describe('a party link is an assertion, not a merge (M3, D2)', () => {
  test('the pair is stored in a fixed order', async () => {
    const { low, high } = pair();
    const reversed = await db.owner
      .query(
        `insert into kernel.party_link
           (id, relation, left_party, right_party, asserted_by, asserted_at,
            confidence, evidence, lawful_basis)
         values ($1, 'same_as', $2, $3, $4, now(), 0.8, 'phone_match',
                 'contract_performance')`,
        [uuidv7(), high, low, uuidv7()],
      )
      .then(() => null, (error: unknown) => error);

    assert.equal(sqlState(reversed), CHECK_VIOLATION);
    assert.match(String((reversed as Error).message), /party_link_ordered/);
  });

  test('a party cannot be linked to itself', async () => {
    const same = uuidv7();
    const failed = await db.owner
      .query(
        `insert into kernel.party_link
           (id, relation, left_party, right_party, asserted_by, asserted_at,
            confidence, evidence, lawful_basis)
         values ($1, 'same_as', $2, $2, $3, now(), 1, 'phone_match',
                 'contract_performance')`,
        [uuidv7(), same, uuidv7()],
      )
      .then(() => null, (error: unknown) => error);

    assert.ok(
      sqlState(failed) === CHECK_VIOLATION,
      'a self-link is a matcher bug, not a claim',
    );
  });

  test('confidence is never zero and never above one', async () => {
    for (const confidence of [0, 1.5, -0.1]) {
      const failed = await link({ confidence }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.equal(
        sqlState(failed),
        CHECK_VIOLATION,
        `confidence ${confidence} should be refused`,
      );
    }
  });

  test('evidence comes from a closed list', async () => {
    const failed = await link({ evidence: 'gut_feeling' }).then(
      () => null,
      (error: unknown) => error,
    );

    assert.equal(sqlState(failed), CHECK_VIOLATION);
    assert.match(String((failed as Error).message), /evidence_known/);
  });

  test('a link carries a lawful basis like any other claim', async () => {
    const failed = await link({ lawful_basis: 'because_we_wanted_to' }).then(
      () => null,
      (error: unknown) => error,
    );

    assert.equal(sqlState(failed), CHECK_VIOLATION);
  });

  test('the same asserter cannot assert the same pair twice', async () => {
    const { low, high } = pair();
    const asserter = uuidv7();
    await link({ left_party: low, right_party: high, asserted_by: asserter });

    const again = await link({
      left_party: low,
      right_party: high,
      asserted_by: asserter,
    }).then(() => null, (error: unknown) => error);

    assert.equal(sqlState(again), UNIQUE_VIOLATION);
  });

  test('a second opinion from a different party is a second row', async () => {
    const { low, high } = pair();
    await link({ left_party: low, right_party: high, asserted_by: uuidv7() });
    const other = await link({
      left_party: low,
      right_party: high,
      asserted_by: uuidv7(),
      confidence: 0.2,
      evidence: 'assumed',
    });

    // Disagreement is data. Two organisations differing about whether two
    // records are the same person is information, not a database conflict.
    assert.equal(other['confidence'], '0.200');
  });
});

describe('a link is withdrawable and a record is not erasable (M3)', () => {
  test('nothing can be deleted, not even by the owner', async () => {
    const row = await link();
    const removed = await db.owner
      .query('delete from kernel.party_link where id = $1', [row['id']])
      .then(() => null, (error: unknown) => error);

    assert.equal(sqlState(removed), RESTRICT_VIOLATION);
  });

  test('the application role has no DELETE at all', async () => {
    const removed = await db.app
      .query('delete from kernel.party_link')
      .then(() => null, (error: unknown) => error);

    assert.equal(sqlState(removed), INSUFFICIENT_PRIVILEGE);
  });

  test('the substance of a link cannot be edited', async () => {
    const row = await link();
    const edited = await db.owner
      .query('update kernel.party_link set confidence = 0.1 where id = $1', [
        row['id'],
      ])
      .then(() => null, (error: unknown) => error);

    assert.equal(sqlState(edited), RESTRICT_VIOLATION);
  });

  test('retraction is the one permitted update, and it is complete', async () => {
    const row = await link();
    const { rows } = await db.owner.query<{ retraction_reason: string }>(
      `update kernel.party_link
          set retracted_at = now(), retracted_by = $2, retraction_reason = $3
        where id = $1 returning retraction_reason`,
      [row['id'], uuidv7(), 'the phone number was reassigned'],
    );

    assert.equal(rows[0]?.retraction_reason, 'the phone number was reassigned');
  });

  test('a half-recorded retraction is refused', async () => {
    const row = await link();
    const partial = await db.owner
      .query('update kernel.party_link set retracted_at = now() where id = $1', [
        row['id'],
      ])
      .then(() => null, (error: unknown) => error);

    assert.equal(
      sqlState(partial),
      CHECK_VIOLATION,
      'who withdrew it and why are the whole point of keeping the row',
    );
  });

  test('a retracted link cannot be retracted again or revived', async () => {
    const row = await link();
    await db.owner.query(
      `update kernel.party_link
          set retracted_at = now(), retracted_by = $2, retraction_reason = 'wrong'
        where id = $1`,
      [row['id'], uuidv7()],
    );

    const revived = await db.owner
      .query(
        `update kernel.party_link
            set retracted_at = null, retracted_by = null, retraction_reason = null
          where id = $1`,
        [row['id']],
      )
      .then(() => null, (error: unknown) => error);

    assert.equal(sqlState(revived), RESTRICT_VIOLATION);
  });
});

describe('links live beside records and never inside them (M3, D2)', () => {
  test('no column anywhere points at a canonical or merged party', async () => {
    const { rows } = await db.owner.query<{ column_name: string }>(
      `select table_name || '.' || column_name as column_name
         from information_schema.columns
        where table_schema in ('facts', 'inference', 'kernel')
          and (column_name like '%canonical%' or column_name like '%merged%'
               or column_name = 'master_party')`,
    );

    assert.deepEqual(
      rows,
      [],
      'a canonical-party column is a merge wearing a link\'s clothes',
    );
  });

  test('a link carries the dataset discriminator like every other claim', async () => {
    const seeded = await link({ dataset: 'seed' });
    assert.equal(seeded['dataset'], 'seed');

    const unknown = await link({ dataset: 'staging' }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.equal(sqlState(unknown), CHECK_VIOLATION);
  });

  test('only same_as exists, so no relation is inferable by accident', async () => {
    const failed = await link({ relation: 'guardian_of' }).then(
      () => null,
      (error: unknown) => error,
    );

    assert.equal(sqlState(failed), CHECK_VIOLATION);
    assert.match(String((failed as Error).message), /relation_known/);
  });
});
