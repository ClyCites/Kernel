import { loadDotenv } from '../dotenv.js';
import { loadConfig } from '../config.js';
import { migrate } from './migrator.js';

loadDotenv();

const config = loadConfig();

const result = await migrate({
  connectionString: config.MIGRATOR_DATABASE_URL,
  appPassword: config.KERNEL_APP_PASSWORD,
  monthsAhead: config.PARTITION_MONTHS_AHEAD,
  log: (message) => console.log(message),
});

console.log(
  `applied ${result.applied.length}, already applied ${result.alreadyApplied.length}, ` +
    `partitions ensured ${result.partitionsEnsured}`,
);
