import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
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

/** Raised by registry.refuse_mutation(). */
const RESTRICT_VIOLATION = '23001';

const TABLES = [
  'unit_conversion',
  'observation_type',
  'crop_code',
  'admin_region',
  'grading_scheme',
  'grading_scheme_value',
];

/**
 * Spec §3.2: a UnitConversion is a versioned entity, not a config file.
 *
 * The failure this guards against is silent. If a factor could be edited in
 * place, every `normalized_kg` already derived from it would change meaning
 * without a single record being rewritten — which is the exact failure the
 * `conversion_id` indirection exists to prevent.
 */
describe('the registry is append-only (spec §3.2)', () => {
  for (const table of TABLES) {
    test(`the application cannot write registry.${table}`, async () => {
      const insert = await db.app
        .query(`insert into registry.${table} default values`)
        .then(() => null, (error: unknown) => error);

      assert.equal(
        sqlState(insert),
        INSUFFICIENT_PRIVILEGE,
        `expected the app role to lack INSERT on registry.${table}`,
      );
    });
  }

  for (const table of TABLES) {
    test(`registry.${table} refuses UPDATE even to its owner`, async () => {
      const update = await db.owner
        .query(`update registry.${table} set created_at = now()`)
        .then(() => null, (error: unknown) => error);

      assert.equal(sqlState(update), RESTRICT_VIOLATION);
      assert.match(String((update as Error).message), /append-only/);
    });
  }

  for (const table of TABLES) {
    test(`registry.${table} refuses DELETE even to its owner`, async () => {
      const remove = await db.owner
        .query(`delete from registry.${table}`)
        .then(() => null, (error: unknown) => error);

      assert.equal(sqlState(remove), RESTRICT_VIOLATION);
    });
  }

  test('a correction is a new row pointing at the one it replaces', async () => {
    const { rows } = await db.owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'registry'
          and table_name = 'unit_conversion'
          and column_name = 'supersedes'`,
    );

    assert.equal(rows.length, 1, 'unit_conversion must carry a supersedes link');
  });

  test('the application can read the registry', async () => {
    const { rows } = await db.app.query<{ count: string }>(
      'select count(*)::text as count from registry.unit_conversion',
    );

    assert.ok(Number(rows[0]?.count) > 0, 'the seed should be readable');
  });
});

describe('the seed is honest about what it does not know', () => {
  test('every commodity-specific factor is marked assumed unless a standard is cited', async () => {
    const { rows } = await db.app.query<{
      id: string;
      basis: string;
      source: string | null;
    }>(
      `select id, basis, source from registry.unit_conversion
        where commodity is not null and basis <> 'assumed_default'`,
    );

    for (const row of rows) {
      assert.ok(
        row.source !== null && row.source.length > 0,
        `${row.id} claims basis ${row.basis} without citing a source`,
      );
    }
  });

  test('a factor claiming to be measured shows the sample it was measured from', async () => {
    // 0012 gave `measured` its real meaning: somebody weighed a sample. The
    // three SI rows from 0010 predate that and are grandfathered — the comment
    // in 0012 says so — but nothing added since may claim `measured` without
    // showing its working.
    const { rows } = await db.app.query<{
      from_unit: string;
      sample_size: number | null;
      source: string | null;
    }>(
      `select from_unit, sample_size, source from registry.unit_conversion
        where basis = 'measured' order by from_unit, id`,
    );

    const grandfathered = new Set(['gram', 'kg', 'tonne']);
    for (const row of rows) {
      if (grandfathered.has(row.from_unit) && row.sample_size === null) continue;
      assert.ok(
        row.sample_size !== null && row.sample_size > 0,
        `a measured ${row.from_unit} factor states no sample size`,
      );
      assert.ok(
        row.source !== null && row.source.length > 0,
        `a measured ${row.from_unit} factor cites no source`,
      );
    }

    assert.ok(
      rows.some((row) => !grandfathered.has(row.from_unit)),
      'no genuinely measured factor exists — the invariant is asserting nothing',
    );
  });

  test('a region-scoped factor always carries its boundary vintage (D6)', async () => {
    const { rows } = await db.app.query<{ count: string }>(
      `select count(*)::text as count from registry.unit_conversion
        where (region_code is null) <> (region_vintage is null)`,
    );

    assert.equal(rows[0]?.count, '0');
  });

  test('no crop code is bound to an external taxonomy while D1 is open', async () => {
    const { rows } = await db.app.query<{ count: string }>(
      `select count(*)::text as count from registry.crop_code
        where external_scheme is not null`,
    );

    assert.equal(
      rows[0]?.count,
      '0',
      'binding a taxonomy here would resolve D1 by accident',
    );
  });

  test('every observation type names an owner (D8)', async () => {
    const { rows } = await db.app.query<{ code: string }>(
      `select code from registry.observation_type
        where owner is null or owner = ''`,
    );

    assert.deepEqual(rows, []);
  });
});
