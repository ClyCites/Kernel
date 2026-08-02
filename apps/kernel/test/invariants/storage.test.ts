import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  NOT_NULL_VIOLATION,
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

const INSERT = `
  insert into facts.record (
    id, type, record_class, schema_version,
    occurred_at, occurred_at_precision, recorded_at,
    asserted_by, on_behalf_of, delegation, supersedes, body
  ) values ($1, $2, $3, '0.2.0', now(), 'day', now(), $4, $5, $6, $7, $8)
`;

async function insertFact(
  overrides: {
    id?: string;
    type?: string;
    recordClass?: string;
    assertedBy?: string | null;
    onBehalfOf?: string | null;
    delegation?: string | null;
    supersedes?: string | null;
  } = {},
): Promise<string> {
  const id = overrides.id ?? uuidv7();
  await db.app.query(INSERT, [
    id,
    overrides.type ?? 'delivery',
    overrides.recordClass ?? 'observation',
    overrides.assertedBy === undefined ? uuidv7() : overrides.assertedBy,
    overrides.onBehalfOf ?? null,
    overrides.delegation ?? null,
    overrides.supersedes ?? null,
    JSON.stringify({ commodity: 'crop.maize.grain' }),
  ]);
  return id;
}

/* ── invariant 1: append-only ─────────────────────────────────────────── */

describe('invariant 1 — append-only (brief §4.1)', () => {
  test('the application role can append a record', async () => {
    const id = await insertFact();
    const { rows } = await db.app.query(
      'select id from facts.record where id = $1',
      [id],
    );
    assert.equal(rows.length, 1);
  });

  test('UPDATE against the fact log is refused by the database', async () => {
    const id = await insertFact();

    const error = await db.app
      .query('update facts.record set type = $2 where id = $1', [id, 'harvest'])
      .then(
        () => null,
        (e: unknown) => e,
      );

    assert.notEqual(error, null, 'UPDATE must not succeed');
    assert.equal(
      sqlState(error),
      INSUFFICIENT_PRIVILEGE,
      'the refusal must come from the role grant, not from application code',
    );
  });

  test('DELETE against the fact log is refused by the database', async () => {
    const id = await insertFact();

    const error = await db.app
      .query('delete from facts.record where id = $1', [id])
      .then(
        () => null,
        (e: unknown) => e,
      );

    assert.notEqual(error, null, 'DELETE must not succeed');
    assert.equal(sqlState(error), INSUFFICIENT_PRIVILEGE);
  });

  test('the same refusal applies to the inference namespace', async () => {
    const updateError = await db.app
      .query('update inference.record set type = $1', ['inference'])
      .then(
        () => null,
        (e: unknown) => e,
      );
    const deleteError = await db.app.query('delete from inference.record').then(
      () => null,
      (e: unknown) => e,
    );

    assert.equal(sqlState(updateError), INSUFFICIENT_PRIVILEGE);
    assert.equal(sqlState(deleteError), INSUFFICIENT_PRIVILEGE);
  });

  test('TRUNCATE is refused, and so is DDL', async () => {
    const truncate = await db.app.query('truncate facts.record').then(
      () => null,
      (e: unknown) => e,
    );
    const ddl = await db.app
      .query('create table facts.smuggled (id uuid primary key)')
      .then(
        () => null,
        (e: unknown) => e,
      );

    assert.equal(sqlState(truncate), INSUFFICIENT_PRIVILEGE);
    assert.equal(sqlState(ddl), INSUFFICIENT_PRIVILEGE);
  });

  test('the grant itself contains no UPDATE or DELETE', async () => {
    const { rows } = await db.owner.query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.role_table_grants
        where grantee = 'kernel_app'
          and table_schema in ('facts', 'inference')`,
    );
    const granted = new Set(rows.map((r) => r.privilege_type));
    assert.deepEqual([...granted].sort(), ['INSERT', 'SELECT']);
  });
});

/* ── invariant 2: observations and inferences never mix ───────────────── */

describe('invariant 2 — separate namespaces (brief §4.2)', () => {
  test('an inference cannot be written into the fact log', async () => {
    const error = await insertFact({ recordClass: 'inference' }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.notEqual(error, null, 'a model output must not reach facts.record');
    assert.equal(sqlState(error), CHECK_VIOLATION);
  });

  test('an observation cannot be written into the inference namespace', async () => {
    const error = await db.app
      .query(
        `insert into inference.record (
           id, type, record_class, schema_version,
           occurred_at, occurred_at_precision, recorded_at, asserted_by, body
         ) values ($1, 'harvest', 'observation', '0.2.0', now(), 'day', now(), $2, '{}')`,
        [uuidv7(), uuidv7()],
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    assert.equal(sqlState(error), CHECK_VIOLATION);
  });

  test('they are different tables in different schemas, not a column', async () => {
    const { rows } = await db.owner.query<{ table_schema: string }>(
      `select table_schema
         from information_schema.tables
        where table_name = 'record'
        order by table_schema`,
    );
    assert.deepEqual(
      rows.map((r) => r.table_schema),
      ['facts', 'inference'],
    );
  });
});

/* ── invariant 3: provenance is mandatory ─────────────────────────────── */

describe('invariant 3 — provenance (brief §4.3)', () => {
  test('a record with no asserted_by cannot be stored', async () => {
    const error = await insertFact({ assertedBy: null }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.equal(sqlState(error), NOT_NULL_VIOLATION);
  });

  test('on_behalf_of without a delegation cannot be stored', async () => {
    const error = await insertFact({ onBehalfOf: uuidv7() }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.equal(
      sqlState(error),
      CHECK_VIOLATION,
      'acting for another party with no delegation is impersonation (spec §4)',
    );
  });

  test('on_behalf_of with a delegation is stored', async () => {
    const id = await insertFact({
      onBehalfOf: uuidv7(),
      delegation: uuidv7(),
    });
    const { rows } = await db.app.query(
      'select delegation from facts.record where id = $1',
      [id],
    );
    assert.notEqual(rows[0]?.delegation, null);
  });
});

/* ── supersession ─────────────────────────────────────────────────────── */

describe('supersession (spec §8)', () => {
  test('a record cannot supersede itself', async () => {
    const id = uuidv7();
    const error = await insertFact({ id, supersedes: id }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.equal(sqlState(error), CHECK_VIOLATION);
  });

  test('there is no superseded_by column to update', async () => {
    const { rows } = await db.owner.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'facts' and table_name = 'record'`,
    );
    const columns = rows.map((r) => r.column_name);
    assert.equal(
      columns.includes('superseded_by'),
      false,
      'superseded_by is derived from the supersedes index, never written back',
    );
  });
});

/* ── partitioning ─────────────────────────────────────────────────────── */

describe('partitioning', () => {
  test('a record lands in the partition for its month, not in DEFAULT', async () => {
    const id = await insertFact();

    const { rows } = await db.owner.query<{ partition: string }>(
      'select tableoid::regclass::text as partition from facts.record where id = $1',
      [id],
    );

    const partition = rows[0]?.partition ?? '';
    assert.match(partition, /^facts\.record_y\d{4}m\d{2}$/, partition);
  });

  test('the DEFAULT partition exists but is empty', async () => {
    const { rows } = await db.owner.query<{ count: string }>(
      'select count(*)::text as count from facts.record_default',
    );
    assert.equal(rows[0]?.count, '0');
  });

  test('provisioning partitions again is a no-op', async () => {
    const before = await db.owner.query<{ n: string }>(
      `select count(*)::text as n from pg_class c
         join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = 'facts' and c.relname like 'record_y%'`,
    );
    await db.owner.query('select kernel.ensure_record_partitions(1, 24)');
    const after = await db.owner.query<{ n: string }>(
      `select count(*)::text as n from pg_class c
         join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = 'facts' and c.relname like 'record_y%'`,
    );

    assert.equal(after.rows[0]?.n, before.rows[0]?.n);
  });
});
