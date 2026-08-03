import { z } from 'zod';

import { DEFAULT_MASS_BALANCE_TOLERANCE } from './records/mass-balance.js';

/**
 * Environment configuration. Validated with the same library the records are
 * validated with — but note this is process configuration, not a core record,
 * so it does not belong in @clycites/schema.
 */
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  MIGRATOR_DATABASE_URL: z.string().min(1),
  KERNEL_APP_PASSWORD: z.string().min(1),
  PARTITION_MONTHS_AHEAD: z.coerce.number().int().min(1).default(24),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /**
   * Spec §9.1. Unexplained shrinkage above this fraction of a lot's opening
   * weight is surfaced. The default is a guess — roughly the moisture loss a
   * coop would not remark on — and stays a guess until the field validation in
   * §13 produces a real number. It is configurable so that number can be
   * adopted without a deploy of new code, and so different commodities can be
   * run at different thresholds while that is being worked out.
   */
  MASS_BALANCE_TOLERANCE: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_MASS_BALANCE_TOLERANCE),
  /**
   * Whether this instance will accept writes marked `dataset: 'seed'`.
   *
   * Off means the dataset header is ignored outright, so a production instance
   * cannot be poisoned with fabricated records however the request is dressed
   * up. It is deliberately a literal `'true'` rather than anything coercible:
   * `z.coerce.boolean()` treats every non-empty string as true, which would
   * turn a stray `SEED_INGEST_ENABLED=no` into a live seeding switch.
   */
  SEED_INGEST_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  NODE_ENV: z.string().default('development'),
});

export type KernelConfig = z.infer<typeof Env>;

/** Nest injection token. Tests construct services directly and pass a literal. */
export const KERNEL_CONFIG = Symbol('KERNEL_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KernelConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid environment configuration — ${detail}`);
  }
  // A copied .env is the ordinary way this happens, and nothing downstream
  // would report it: seeded records are well formed and indistinguishable from
  // real ones once written, and the log is append-only. Refusing to start is
  // the last point at which it is still cheap.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.SEED_INGEST_ENABLED) {
    throw new Error(
      'refusing to start: SEED_INGEST_ENABLED is true in production. ' +
        'Fabricated records cannot be removed from an append-only log.',
    );
  }
  return parsed.data;
}
