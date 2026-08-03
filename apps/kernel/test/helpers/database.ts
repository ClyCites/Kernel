import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Pool } from 'pg';

import { migrate } from '../../src/storage/migrator.js';

/** Matches docker-compose.yml. See docs/decisions/0004-postgis-image.md. */
export const POSTGIS_IMAGE = 'imresamu/postgis:16-3.5';

const APP_PASSWORD = 'kernel_app_test';

export interface TestDatabase {
  /** Connected as the schema owner. Can do anything. Used only for setup. */
  owner: Pool;
  /**
   * Connected as `kernel_app` — the role the running kernel uses. INSERT and
   * SELECT on record tables, nothing else. Every assertion about what the
   * kernel can and cannot do must go through this pool.
   */
  app: Pool;
  ownerUrl: string;
  appPassword: string;
  /**
   * The running container. Exposed so the operational scripts can be executed
   * where the Postgres client tools actually live — see test/ops/restore.test.ts.
   */
  container: StartedPostgreSqlContainer;
  stop: () => Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    POSTGIS_IMAGE,
  )
    .withDatabase('clycites')
    .withUsername('clycites_owner')
    .withPassword('clycites_owner_test')
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const ownerUrl = container.getConnectionUri();

  await migrate({ connectionString: ownerUrl, appPassword: APP_PASSWORD });

  const owner = new Pool({ connectionString: ownerUrl });
  const app = new Pool({
    connectionString: `postgres://kernel_app:${APP_PASSWORD}@${host}:${port}/clycites`,
  });

  return {
    owner,
    app,
    ownerUrl,
    appPassword: APP_PASSWORD,
    container,
    stop: async () => {
      // A Nest app under test ends the pool through its shutdown hook first.
      await app.end().catch(() => {});
      await owner.end().catch(() => {});
      await container.stop();
    },
  };
}

/** Postgres SQLSTATE for insufficient_privilege. */
export const INSUFFICIENT_PRIVILEGE = '42501';

export function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Postgres SQLSTATE for check_violation. */
export const CHECK_VIOLATION = '23514';
/** Postgres SQLSTATE for not_null_violation. */
export const NOT_NULL_VIOLATION = '23502';
