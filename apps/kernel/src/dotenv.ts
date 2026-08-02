import { existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Load `.env` from the nearest ancestor directory that has one. Commands are
 * run both from the repository root (`pnpm migrate`) and from `apps/kernel`
 * (pnpm sets the cwd per package), and the file lives at the root.
 */
export function loadDotenv(from: string = process.cwd()): string | null {
  let dir = path.resolve(from);

  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate, quiet: true });
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
