import { Pool } from 'pg';

export const KERNEL_POOL = Symbol('KERNEL_POOL');

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    // Field traffic is bursty and thin. A small pool keeps connection count
    // predictable; there is no evidence yet to size it from.
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}
