import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

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

/**
 * Work order M6. Every observation type invented at a desk is one somebody has
 * to deprecate later, and records citing a code are permanent, so a wrong code
 * is permanent too. Decision 0028.
 */
describe('the observation vocabulary stays small and cited (M6, D8)', () => {
  /**
   * The three rows seeded in 0010 with no source. They are exactly what the
   * rule exists to prevent — plausible, unused, and registered because someone
   * could imagine wanting them — and the registry refuses DELETE, so they
   * cannot be withdrawn. Naming them here means the day one acquires a real
   * citation is a deliberate edit rather than a silently shrinking list.
   */
  const UNCITED_AT_0020 = ['pest.incidence', 'soil.ph', 'storage.condition'];

  /** Mirrors registry.observation_type_ceiling(). Raising it is a migration. */
  const CEILING = 12;

  test('nothing new may be added without a citation', async () => {
    const { rows } = await db.app.query<{ code: string }>(
      `select code from registry.observation_type
        where source is null or btrim(source) = ''
        order by code`,
    );

    assert.deepEqual(
      rows.map((row) => row.code),
      UNCITED_AT_0020,
      'an uncited observation type appeared that 0020 did not grandfather',
    );
  });

  test('the citation rule is enforced by the database, not by review', async () => {
    const failed = await db.owner
      .query(
        `insert into registry.observation_type
           (code, version, label, value_kind, permitted_methods, subject_types, owner, source)
         values ('test.uncited', 1, 'Uncited', 'scalar',
                 array['reported'], array['plot'], 'clycites.kernel', null)`,
      )
      .then(() => null, (error: unknown) => error);

    assert.equal(sqlState(failed), CHECK_VIOLATION);
    assert.match(String((failed as Error).message), /observation_type_cited/);
  });

  test('the vocabulary stays below a deliberate ceiling', async () => {
    const { rows } = await db.app.query<{ count: string }>(
      'select count(distinct code)::text as count from registry.observation_type',
    );

    const present = Number(rows[0]?.count);
    assert.ok(
      present < CEILING,
      `${present} observation types against a ceiling of ${CEILING}: either ` +
        'the vocabulary has grown past what anyone asked for, or the ceiling ' +
        'needs a migration and a written reason',
    );
  });
});

/**
 * Work order M4. Decision 0027 defers open decision D5 rather than answering
 * it: the table holds both a national and a coop definition of a season, and
 * says which is which.
 */
describe('the season calendar holds only what it can cite (M4, D5)', () => {
  test('every row cites a source and is marked published or observed', async () => {
    const { rows } = await db.app.query<{
      label: string;
      basis: string;
      source: string | null;
    }>('select label, basis, source from registry.season_calendar');

    assert.ok(rows.length > 0, 'the calendar is empty — nothing is asserted');
    for (const row of rows) {
      assert.ok(
        row.source !== null && row.source.trim().length > 0,
        `${row.label} has no citation`,
      );
      assert.ok(['published', 'observed'].includes(row.basis));
    }
  });

  test('nothing claims to be observed while nobody has been to a field', async () => {
    const { rows } = await db.app.query<{ count: string }>(
      `select count(*)::text as count from registry.season_calendar
        where basis = 'observed'`,
    );

    assert.equal(
      rows[0]?.count,
      '0',
      'an observed season boundary implies field work that has not happened',
    );
  });

  test('a season nobody published has no row rather than a guess', async () => {
    // The GIEWS brief says nothing about the second season, so there is no
    // 2026B row. An empty answer is the honest one.
    const { rows } = await db.app.query<{ count: string }>(
      `select count(*)::text as count from registry.season_calendar
        where label = '2026B'`,
    );

    assert.equal(rows[0]?.count, '0');
  });

  test('a season is scoped to a region that exists at that vintage', async () => {
    const { rows } = await db.app.query<{ count: string }>(
      `select count(*)::text as count
         from registry.season_calendar s
         left join registry.admin_region r
           on r.code = s.region_code and r.vintage = s.region_vintage
        where r.code is null`,
    );

    assert.equal(rows[0]?.count, '0');
  });

  test('the calendar is append-only for its owner too', async () => {
    const update = await db.owner
      .query("update registry.season_calendar set basis = 'observed'")
      .then(() => null, (error: unknown) => error);

    assert.equal(sqlState(update), RESTRICT_VIOLATION);
  });
});
