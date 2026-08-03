import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import type { ShippedEntry } from './audit.repository.js';

export type ShipConfig = Pick<
  KernelConfig,
  | 'AUDIT_SHIP_URL'
  | 'AUDIT_SHIP_TOKEN'
  | 'AUDIT_SHIP_INTERVAL_SECONDS'
  | 'AUDIT_SHIP_BATCH'
>;

/**
 * The queue is bounded. An unbounded one turns an unreachable collector into an
 * out-of-memory kill, which loses every pending entry instead of the oldest
 * few and takes the kernel down with it.
 */
export const MAX_QUEUE = 10_000;

/**
 * The off-box copy of the audit log.
 *
 * WHAT THIS IS FOR. The database copy is the statutory record and it is written
 * synchronously — see audit.service.ts. This is the tamper-evidence copy, and
 * its only property that matters is that it lives somewhere an operator with
 * credentials to this database cannot reach. 0001 concedes that the schema
 * owner can delete rows and drop triggers; a copy they cannot reach is what
 * makes that concession survivable, because the deletion becomes visible.
 *
 * WHAT IT MUST NEVER DO. Fail a request. A farmer's delivery does not go
 * unrecorded because a log collector in another data centre is down. Every path
 * out of this class swallows its errors and counts them; nothing here is
 * awaited by a request.
 *
 * FINDING, stated rather than glossed: entries queued and not yet shipped are
 * lost if the process dies. They are not lost from the database, which is the
 * record of legal consequence, so a privileged operator can reconcile from
 * there. What is genuinely lost in that window is the tamper evidence, for
 * those entries only. Closing it properly means shipping from a reader outside
 * this process, which would need SELECT on the audit table — and handing the
 * application SELECT to buy that is a bad trade. See docs/decisions/0025.
 */
@Injectable()
export class AuditShipper implements OnApplicationShutdown {
  private readonly logger = new Logger('audit');
  private readonly queue: ShippedEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  /** Observable counters, so "shipping is quietly broken" is a visible state. */
  readonly counters = { queued: 0, shipped: 0, dropped: 0, failures: 0 };

  constructor(
    @Inject(KERNEL_CONFIG)
    private readonly config: ShipConfig,
  ) {}

  get enabled(): boolean {
    return this.config.AUDIT_SHIP_URL !== '';
  }

  /** Synchronous, and returns nothing. There is no promise to forget to await. */
  enqueue(entry: ShippedEntry): void {
    if (!this.enabled) return;

    if (this.queue.length >= MAX_QUEUE) {
      // Oldest first: recent entries are the ones an incident is about.
      this.queue.shift();
      this.counters.dropped += 1;
    }
    this.queue.push(entry);
    this.counters.queued += 1;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.config.AUDIT_SHIP_INTERVAL_SECONDS * 1000);
    // Do not hold the event loop open for a best-effort copy.
    this.timer.unref?.();
  }

  /**
   * Drains what it can and returns. Never throws — a caller that could be given
   * an error would eventually be given one from a request handler.
   */
  async flush(): Promise<void> {
    if (this.inFlight || !this.enabled) return;
    this.inFlight = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.config.AUDIT_SHIP_BATCH);
        const sent = await this.post(batch);
        if (!sent) {
          // Put them back at the front and stop. Retrying immediately against a
          // collector that just refused makes an outage worse, and the interval
          // timer will come round again.
          this.queue.unshift(...batch);
          return;
        }
        this.counters.shipped += batch.length;
      }
    } finally {
      this.inFlight = false;
      if (this.queue.length > 0) this.schedule();
    }
  }

  private async post(batch: ShippedEntry[]): Promise<boolean> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.config.AUDIT_SHIP_TOKEN !== '') {
      headers['authorization'] = `Bearer ${this.config.AUDIT_SHIP_TOKEN}`;
    }

    try {
      const response = await fetch(this.config.AUDIT_SHIP_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ entries: batch }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        this.counters.failures += 1;
        // Status only. The response body of a collector that is misbehaving is
        // not something to copy into our own logs.
        this.logger.warn(
          `audit shipping refused with ${response.status}; ${this.queue.length + batch.length} entries pending`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.counters.failures += 1;
      this.logger.warn(
        `audit shipping failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // One last attempt on a clean shutdown, which is the case where the queue
    // can actually be saved.
    await this.flush();
  }
}
