import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import { loadMigrations, migrate } from '../../src/storage/migrator.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase();
});

after(async () => {
  await db.stop();
});

describe('migration runner', () => {
  test('the migrations in this repository are numbered and unique', async () => {
    const migrations = await loadMigrations();
    assert.ok(migrations.length > 0);
    const versions = migrations.map((m) => m.version);
    assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
    assert.equal(new Set(versions).size, versions.length);
  });

  test('re-running applies nothing and still provisions partitions', async () => {
    const result = await migrate({
      connectionString: db.ownerUrl,
      appPassword: db.appPassword,
      trainingPassword: db.appPassword,
    });

    assert.deepEqual(result.applied, []);
    assert.ok(result.alreadyApplied.length > 0);
    assert.ok(result.partitionsEnsured > 0);
  });

  test('an applied migration whose bytes changed is refused', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'clycites-migrations-'));
    await writeFile(
      path.join(directory, '0001_roles.sql'),
      '-- not what was applied\n',
      'utf8',
    );

    const error = await migrate({
      connectionString: db.ownerUrl,
      appPassword: db.appPassword,
      trainingPassword: db.appPassword,
      directory,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.match(
      String(error),
      /has changed since it was applied/,
      'migrations are immutable history; editing one must be caught',
    );
  });

  test('a failing migration leaves nothing behind', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'clycites-migrations-'));
    await writeFile(
      path.join(directory, '0900_broken.sql'),
      'create table kernel.half_applied (id int);\nselect 1 / 0;\n',
      'utf8',
    );

    const error = await migrate({
      connectionString: db.ownerUrl,
      appPassword: db.appPassword,
      trainingPassword: db.appPassword,
      directory,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.notEqual(error, null);

    const { rows } = await db.owner.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
          where table_schema = 'kernel' and table_name = 'half_applied'
       ) as exists`,
    );
    assert.equal(
      rows[0]?.exists,
      false,
      'each migration runs in its own transaction',
    );

    const recorded = await db.owner.query(
      'select 1 from kernel.schema_migration where version = 900',
    );
    assert.equal(recorded.rowCount, 0);
  });

  test('a badly named migration file is rejected outright', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'clycites-migrations-'));
    await writeFile(path.join(directory, 'add-a-column.sql'), 'select 1;', 'utf8');

    const error = await loadMigrations(directory).then(
      () => null,
      (e: unknown) => e,
    );

    assert.match(String(error), /must look like 0001_name\.sql/);
  });
});
