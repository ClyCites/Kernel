import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import { deliveryDocument, ingestServiceFor } from '../helpers/fixtures.js';
import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import type { TestIngest } from '../helpers/fixtures.js';

/**
 * The restore test.
 *
 * An untested backup is a belief, not a backup — and for an append-only log the
 * belief is unusually dangerous, because there is no reconciliation afterwards.
 * If a restore silently drops rows or loses a constraint, nothing in the rest of
 * this suite would notice: every other test runs against a database that already
 * has the constraint.
 *
 * The scripts run inside the Postgres container rather than on the host. That is
 * not a shortcut. pg_dump refuses to dump a server newer than itself, so running
 * them where the server lives is the only way to guarantee the client and server
 * majors match, and it means the test needs nothing installed beyond Docker.
 * The bytes executed are the same bytes that ship.
 */

const SCRIPTS = fileURLToPath(new URL('../../../../scripts', import.meta.url));
const IN_CONTAINER = '/tmp/kernel-scripts';
const BACKUPS = '/tmp/kernel-backups';
const PASSPHRASE = 'restore-test-only';

/** The database's view of itself, from inside its own container. */
const OWNER_URL =
  'postgres://clycites_owner:clycites_owner_test@localhost:5432/clycites';
const SCRATCH_URL =
  'postgres://clycites_owner:clycites_owner_test@localhost:5432/clycites_restore';

let db: TestDatabase;
let ingest: TestIngest;
let backupDir: string;

interface Ran {
  exitCode: number;
  output: string;
}

const run = async (script: string, args: string[] = []): Promise<Ran> => {
  const result = await db.container.exec(
    ['bash', `${IN_CONTAINER}/${script}`, ...args],
    { env: { BACKUP_PASSPHRASE: PASSPHRASE } },
  );
  return { exitCode: result.exitCode, output: result.output };
};

before(async () => {
  db = await startTestDatabase();
  ({ ingest } = ingestServiceFor(db.app));

  // Something to lose. An empty database restores perfectly and proves nothing.
  for (let i = 0; i < 5; i += 1) await ingest.ingest(deliveryDocument());

  await db.container.copyFilesToContainer([
    {
      source: `${SCRIPTS}/backup.sh`,
      target: `${IN_CONTAINER}/backup.sh`,
      mode: 0o755,
    },
    {
      source: `${SCRIPTS}/restore.sh`,
      target: `${IN_CONTAINER}/restore.sh`,
      mode: 0o755,
    },
  ]);
});

after(async () => {
  await db.stop();
});

describe('a backup can be restored, and the restore is checked', () => {
  test('the backup writes an encrypted dump and a manifest', async () => {
    const backup = await run('backup.sh', [OWNER_URL, BACKUPS]);
    assert.equal(backup.exitCode, 0, backup.output);

    const line = /backup: output=(\S+)/.exec(backup.output);
    assert.notEqual(line, null, `no output directory in:\n${backup.output}`);
    backupDir = line![1]!;

    const listing = await db.container.exec(['ls', backupDir]);
    assert.match(listing.output, /kernel\.dump\.enc/);
    assert.match(listing.output, /manifest\.txt/);
    assert.match(listing.output, /checksums\.sha256/);
  });

  test('the dump on disk is not readable as a dump', async () => {
    // If this ever reads as plaintext, the backup is a copy of the fact log
    // sitting unencrypted on whatever host the cron job runs on.
    const head = await db.container.exec([
      'bash',
      '-c',
      `head -c 8 ${backupDir}/kernel.dump.enc; echo; ` +
        `head -c 8192 ${backupDir}/kernel.dump.enc | grep -ao PGDMP || true`,
    ]);
    assert.equal(head.exitCode, 0, head.output);
    assert.match(head.output, /^Salted__/, 'not an openssl salted stream');
    assert.doesNotMatch(head.output, /PGDMP/, 'the dump header is legible');
  });

  test('the restore comes back matching the manifest', async () => {
    const restored = await run('restore.sh', [backupDir, SCRATCH_URL]);
    assert.equal(restored.exitCode, 0, restored.output);
    assert.match(restored.output, /restore: verified/);
  });

  test('the restored database holds the records that were dumped', async () => {
    const counted = await db.container.exec([
      'psql',
      '--tuples-only',
      '--no-align',
      SCRATCH_URL,
      '-c',
      'select count(*) from facts.record',
    ]);
    assert.equal(counted.output.trim(), '5');
  });
});

/*
 * The verification has to be able to fail. A comparison that cannot report a
 * mismatch is indistinguishable from no comparison at all, and it is the state
 * a verification script drifts into.
 */
describe('the verification fails when the database is not the one dumped', () => {
  const tamper = async (sed: string): Promise<Ran> => {
    await db.container.exec([
      'bash',
      '-c',
      `cp -r ${backupDir} ${backupDir}-tampered && rm -f ${backupDir}-tampered/checksums.sha256 && sed -i '${sed}' ${backupDir}-tampered/manifest.txt`,
    ]);
    const result = await run('restore.sh', [
      `${backupDir}-tampered`,
      SCRATCH_URL,
    ]);
    await db.container.exec(['rm', '-rf', `${backupDir}-tampered`]);
    return result;
  };

  test('a row count that does not match is refused', async () => {
    const result = await tamper('s|^table facts.record 5 |table facts.record 6 |');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /restore: FAILED/);
    assert.match(result.output, /facts\.record/);
  });

  test('a missing constraint is refused', async () => {
    // The one that matters most: a database missing this still starts, still
    // serves traffic, and will accept a record with no DPPA basis (0019).
    const result = await tamper('/facts_lawful_basis_stated/d');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /facts_lawful_basis_stated/);
  });

  test('a missing grant is refused, because append-only is a grant', async () => {
    const result = await tamper('/^privilege facts.record kernel_app INSERT/d');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /kernel_app/);
  });
});

describe('the restore script will not destroy something it should not', () => {
  test('a target whose name does not say it is disposable is refused', async () => {
    const result = await run('restore.sh', [backupDir, OWNER_URL]);
    assert.equal(result.exitCode, 2);
    assert.match(result.output, /refusing to drop "clycites"/);
  });

  test('the live database is untouched by the refusal', async () => {
    const counted = await db.app.query<{ count: string }>(
      'select count(*)::text as count from facts.record',
    );
    assert.equal(counted.rows[0]!.count, '5');
  });

  test('a dump cannot be read without the passphrase', async () => {
    const result = await db.container.exec(
      ['bash', `${IN_CONTAINER}/restore.sh`, backupDir, SCRATCH_URL],
      { env: { BACKUP_PASSPHRASE: 'wrong' } },
    );
    assert.notEqual(result.exitCode, 0);
  });
});
