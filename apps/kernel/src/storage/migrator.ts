import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  connectionString: string;
  appPassword: string;
  monthsAhead?: number;
  directory?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
  partitionsEnsured: number;
}

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(
  directory = MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const files: MigrationFile[] = [];

  for (const entry of entries.sort()) {
    const match = FILENAME.exec(entry);
    if (!match) {
      if (entry.endsWith('.sql')) {
        throw new Error(
          `migration filename must look like 0001_name.sql, got "${entry}"`,
        );
      }
      continue;
    }
    const sql = await readFile(path.join(directory, entry), 'utf8');
    files.push({
      version: Number(match[1]),
      name: entry,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  files.sort((a, b) => a.version - b.version);

  files.forEach((file, index) => {
    const previous = files[index - 1];
    if (previous && previous.version === file.version) {
      throw new Error(
        `duplicate migration version ${file.version}: ${previous.name} and ${file.name}`,
      );
    }
  });

  return files;
}

/**
 * Forward-only migrations. Each file runs inside its own transaction, so a
 * failure leaves the database on the last complete migration rather than
 * halfway through one.
 *
 * There is no `down`. A schema that can be rolled back invites rolling back,
 * and a rollback against an append-only log destroys records.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const migrations = await loadMigrations(options.directory);
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    await client.query(`
      create schema if not exists kernel;
      create table if not exists kernel.schema_migration (
        version     integer     primary key,
        name        text        not null,
        checksum    text        not null,
        applied_at  timestamptz not null default now()
      );
    `);

    const { rows } = await client.query<{
      version: number;
      name: string;
      checksum: string;
    }>('select version, name, checksum from kernel.schema_migration');
    const applied = new Map(rows.map((r) => [r.version, r]));

    // A migration that has already run is history. If its bytes have changed,
    // the file and the database disagree about what was applied, and every
    // later assumption is unsound.
    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      if (previous && previous.checksum !== migration.checksum) {
        throw new Error(
          `migration ${migration.name} has changed since it was applied ` +
            `(recorded ${previous.checksum.slice(0, 12)}, ` +
            `file ${migration.checksum.slice(0, 12)}). Migrations are immutable; ` +
            `write a new one.`,
        );
      }
    }

    const result: MigrateResult = {
      applied: [],
      alreadyApplied: [],
      partitionsEnsured: 0,
    };

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        result.alreadyApplied.push(migration.name);
        continue;
      }

      log(`applying ${migration.name}`);
      try {
        await client.query('begin');
        // Transaction-local, so the password never reaches the server log via
        // a persistent setting and never appears in a migration file.
        await client.query('select set_config($1, $2, true)', [
          'kernel.app_password',
          options.appPassword,
        ]);
        await client.query(migration.sql);
        await client.query(
          'insert into kernel.schema_migration (version, name, checksum) values ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migration ${migration.name} failed: ${String(error)}`, {
          cause: error,
        });
      }
      result.applied.push(migration.name);
    }

    // Partition provisioning is idempotent and runs on every migrate, which is
    // what keeps the window rolling forward without a scheduler. See
    // migrations/0004_partitions.sql.
    const ensured = await client.query<{ ensure_record_partitions: number }>(
      'select kernel.ensure_record_partitions(1, $1)',
      [options.monthsAhead ?? 24],
    );
    result.partitionsEnsured = ensured.rows[0]?.ensure_record_partitions ?? 0;

    return result;
  } finally {
    await client.end();
  }
}
