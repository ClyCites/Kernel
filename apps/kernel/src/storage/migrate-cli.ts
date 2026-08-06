import { loadDotenv } from '../dotenv.js';
import { loadConfig } from '../config.js';
import { migrate } from './migrator.js';

loadDotenv();

const config = loadConfig();

const migratorDatabaseUrl = config.MIGRATOR_DATABASE_URL;
if (migratorDatabaseUrl === undefined) {
  throw new Error('MIGRATOR_DATABASE_URL is not set — migrations require the schema owner connection');
}

const appPassword = config.KERNEL_APP_PASSWORD;
if (appPassword === undefined) {
  throw new Error('KERNEL_APP_PASSWORD is not set — migrations provision the kernel_app role');
}

// Required here and nowhere else. The role has to exist before anything can
// connect as it, and a migration that silently skipped provisioning it would
// leave the training guard looking present and doing nothing.
const trainingPassword = config.KERNEL_TRAINING_PASSWORD;
if (trainingPassword === undefined) {
  throw new Error(
    'KERNEL_TRAINING_PASSWORD is not set — migration 0028 provisions the ' +
      'kernel_training role and cannot invent its credential',
  );
}

const result = await migrate({
  connectionString: migratorDatabaseUrl,
  appPassword,
  trainingPassword,
  monthsAhead: config.PARTITION_MONTHS_AHEAD,
  log: (message) => console.log(message),
});

console.log(
  `applied ${result.applied.length}, already applied ${result.alreadyApplied.length}, ` +
    `partitions ensured ${result.partitionsEnsured}`,
);
