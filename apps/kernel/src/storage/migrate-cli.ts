import { loadDotenv } from '../dotenv.js';
import { loadConfig } from '../config.js';
import { migrate } from './migrator.js';

loadDotenv();

const config = loadConfig();

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
  connectionString: config.MIGRATOR_DATABASE_URL,
  appPassword: config.KERNEL_APP_PASSWORD,
  trainingPassword,
  monthsAhead: config.PARTITION_MONTHS_AHEAD,
  log: (message) => console.log(message),
});

console.log(
  `applied ${result.applied.length}, already applied ${result.alreadyApplied.length}, ` +
    `partitions ensured ${result.partitionsEnsured}`,
);
