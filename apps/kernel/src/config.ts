import { z } from 'zod';

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
});

export type KernelConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KernelConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid environment configuration — ${detail}`);
  }
  return parsed.data;
}
