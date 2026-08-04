import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Optional } from '@nestjs/common';
import { Pool } from 'pg';

import { TRAINING_POOL, TrainingRepository } from './training.repository.js';

/**
 * Its own module, with its own pool, importing nothing from `src/inference`.
 *
 * The separation is enforced twice over: by the grants on `kernel_training`,
 * which is the control that actually holds, and by this module's import list,
 * which is the thing a reviewer can see. Neither alone would be enough — the
 * grants are invisible in a pull request, and the import list is one line away
 * from being changed.
 *
 * `TRAINING_DATABASE_URL` unset yields a null pool and every training query
 * fails. That is the safe direction: an instance that cannot be configured for
 * training should serve nothing rather than fall back to the app connection,
 * which can read predictions.
 */
@Module({
  providers: [
    {
      provide: TRAINING_POOL,
      useFactory: () => {
        // Read straight from the environment rather than through `loadConfig`.
        // This is the one optional connection in the system: a deployment
        // without a training path has no reason to hold the credential, and
        // validating the whole configuration here would make an unrelated
        // missing variable fail a module that does nothing.
        const url = process.env['TRAINING_DATABASE_URL'];
        return url === undefined || url === ''
          ? null
          : new Pool({ connectionString: url, max: 4 });
      },
    },
    TrainingRepository,
  ],
  exports: [TrainingRepository],
})
export class TrainingModule implements OnApplicationShutdown {
  constructor(
    @Optional() @Inject(TRAINING_POOL) private readonly pool: Pool | null = null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }
}
