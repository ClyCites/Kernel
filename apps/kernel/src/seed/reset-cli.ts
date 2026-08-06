import '../dotenv.js';

import { Pool } from 'pg';

import { generate } from './generate.js';
import type { YieldProfile } from './fixtures.js';
import { DEFAULT_SEED } from './random.js';
import { writePlan } from './write.js';

const connectionString = process.env['MIGRATOR_DATABASE_URL'];
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error('MIGRATOR_DATABASE_URL is required for the owner-only seed reset');
}

const baseUrl = process.env['SEED_BASE_URL'] ?? 'http://127.0.0.1:3000';
const profile = (process.env['SEED_YIELD_PROFILE'] ?? 'demo') as YieldProfile;
if (profile !== 'demo' && profile !== 'faostat') {
  throw new Error('SEED_YIELD_PROFILE must be demo or faostat');
}

const seed = Number(process.env['SEED_RANDOM_SEED'] ?? DEFAULT_SEED);
if (!Number.isFinite(seed)) throw new Error('SEED_RANDOM_SEED must be a number');

const pool = new Pool({ connectionString, max: 1 });
try {
  const result = await pool.query<{ removed: string }>(
    'select kernel.reset_seed_corpus()::text as removed',
  );
  const report = await writePlan(generate(seed, profile), { baseUrl });
  if (report.surprises.length > 0) {
    throw new Error(`seed reset produced ${report.surprises.length} unexpected outcomes`);
  }
  process.stdout.write(
    `removed ${result.rows[0]?.removed ?? '0'} seed rows; ` +
      `accepted ${report.accepted}, expected refusals ${report.rejected}\n`,
  );
} finally {
  await pool.end();
}