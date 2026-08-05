import { Pool } from 'pg';

import { loadDotenv } from '../dotenv.js';
import { MediaRepository } from './media.repository.js';
import { ObjectStore } from './objects.js';

/**
 * The object half of a backup.
 *
 * `scripts/backup.sh` fingerprints Postgres and nothing else, which was the
 * whole story until work order H. It is now half a backup: a restore that
 * recovers every row and no objects leaves every `MediaRef` pointing at
 * nothing — and looks completely healthy doing it, because every foreign key
 * still resolves, every count still matches, and the missing thing is in a
 * different system that nobody asked.
 *
 *   manifest  what the database says the bucket should hold, and what it
 *             actually holds. Written into the backup alongside the SQL
 *             manifest.
 *   verify    re-read both and compare. Exits non-zero when an object the
 *             database names is not in the bucket.
 *
 * Both modes are safe to run against a live system: nothing here writes.
 *
 *   tsx src/media/inventory-cli.ts manifest [--dataset live]
 *   tsx src/media/inventory-cli.ts verify   [--dataset live]
 */

interface Options {
  mode: 'manifest' | 'verify';
  dataset: string;
}

function parse(argv: readonly string[]): Options {
  const mode = argv[0];
  if (mode !== 'manifest' && mode !== 'verify') {
    throw new Error('usage: inventory-cli.ts <manifest|verify> [--dataset live]');
  }
  const at = argv.indexOf('--dataset');
  const dataset = at === -1 ? 'live' : (argv[at + 1] ?? 'live');
  if (dataset !== 'live' && dataset !== 'seed') {
    throw new Error(`unknown dataset ${dataset}`);
  }
  return { mode, dataset };
}

function storeFromEnvironment(): ObjectStore {
  const endpoint = process.env['MEDIA_S3_ENDPOINT'];
  const bucket = process.env['MEDIA_S3_BUCKET'];
  const accessKeyId = process.env['MEDIA_S3_ACCESS_KEY'];
  const secretAccessKey = process.env['MEDIA_S3_SECRET_KEY'];

  if (
    endpoint === undefined || bucket === undefined ||
    accessKeyId === undefined || secretAccessKey === undefined
  ) {
    throw new Error(
      'no object store is configured — set MEDIA_S3_ENDPOINT, MEDIA_S3_BUCKET, ' +
        'MEDIA_S3_ACCESS_KEY and MEDIA_S3_SECRET_KEY',
    );
  }

  return new ObjectStore({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env['MEDIA_S3_REGION'] ?? 'us-east-1',
    forcePathStyle: process.env['MEDIA_S3_PATH_STYLE'] !== 'false',
  });
}

async function main(): Promise<void> {
  loadDotenv();
  const options = parse(process.argv.slice(2));

  const url =
    process.env['BACKUP_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    process.env['MIGRATOR_DATABASE_URL'];
  if (url === undefined) {
    throw new Error('no connection url — set BACKUP_DATABASE_URL or DATABASE_URL');
  }

  const pool = new Pool({ connectionString: url });
  const store = storeFromEnvironment();
  const media = new MediaRepository(pool);

  try {
    const inventory = await media.inventory(options.dataset);
    const expected = await media.storageRefs(options.dataset);
    const present = new Set(
      (await store.list(`${options.dataset}/`)).map((object) => object.key),
    );

    if (options.mode === 'manifest') {
      // Two lines, and the difference between them is the point. The first is
      // what the database believes; the second is what the store actually
      // holds. A backup taken while the two disagreed should say so rather
      // than record the disagreement as normal.
      process.stdout.write(
        `object ${options.dataset} ${inventory.object_count} ` +
          `${inventory.byte_total} ${inventory.digest}\n`,
      );
      process.stdout.write(`bucket ${options.dataset} ${present.size}\n`);
      return;
    }

    const missing = expected.filter((ref) => !present.has(ref));
    // Extra keys are reported but are not a failure. Content-addressed storage
    // means an object with no row is an upload that was stored and then failed
    // to register — wasted space, not lost evidence, and deleting it here
    // would be this script exceeding its brief.
    const extra = [...present].filter((key) => !expected.includes(key));

    process.stdout.write(
      `objects: ${expected.length} named by the database, ${present.size} in the bucket\n`,
    );
    for (const key of extra.slice(0, 20)) {
      process.stdout.write(`objects: unreferenced ${key}\n`);
    }

    if (missing.length > 0) {
      process.stderr.write(
        `objects: FAILED — ${missing.length} object(s) the database names are ` +
          'not in the bucket. Every MediaRef citing one of these points at ' +
          'nothing.\n',
      );
      for (const ref of missing.slice(0, 20)) {
        process.stderr.write(`objects:   missing ${ref}\n`);
      }
      process.exitCode = 1;
      return;
    }

    process.stdout.write('objects: verified — every named object is present\n');
  } finally {
    await pool.end();
  }
}

await main();
