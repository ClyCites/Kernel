import { Inject, Injectable } from '@nestjs/common';

import { AuditDescriptor, type AuditEntry } from './audit.entry.js';
import { AuditRepository } from './audit.repository.js';
import { AuditShipper } from './audit.shipper.js';

/**
 * The audit log. Work order F.
 *
 * This is a statutory record, not a log. DPPA s.24(1)(c) gives a data subject
 * the right to be told the identity of every third party who accessed their
 * data; s.16(4) requires notifying those parties when a record is corrected.
 * Both questions are answerable only from here, and a missing entry is not an
 * observability gap — it is a legally wrong answer to a subject's request.
 *
 * Two consequences follow, and they pull in opposite directions from the usual
 * treatment of logging:
 *
 * THE DATABASE WRITE IS AWAITED AND IS ALLOWED TO FAIL THE REQUEST. A
 * disclosure that cannot be recorded does not happen. This kernel fails closed
 * elsewhere for the same reason (see consent.service.ts), and a read path that
 * quietly proceeds when its audit write failed is a read path that cannot be
 * answered for afterwards. Ingest is idempotent per id, so a write that appends
 * and then fails to audit is safe for the client to retry.
 *
 * SHIPPING OFF-BOX IS NOT AWAITED AND CANNOT FAIL THE REQUEST. That copy exists
 * to survive an operator with credentials to this database, and a collector
 * being unreachable is not a reason to refuse a farmer's delivery.
 *
 * BODIES ARE NEVER RECORDED. Ids and query descriptors only. An audit log full
 * of personal data is a second copy of the thing it protects, sitting in a
 * schema the application can write but not read — a worse exposure than the one
 * it was built to detect. `AuditDescriptor` cannot represent a nested object,
 * so this is a property of the type rather than a rule to remember.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(AuditRepository) private readonly repository: AuditRepository,
    @Inject(AuditShipper) private readonly shipper: AuditShipper,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const written = await this.repository.append({
      ...entry,
      detail: this.descriptor(entry.detail),
    });
    this.shipper.enqueue(written);
  }

  /**
   * The last line of defence against a body reaching the log.
   *
   * The type forbids it, the database caps the serialised size, and this
   * discards anything that got past both — a value that fails the schema is
   * dropped rather than stringified, because a truncated body is still a body.
   */
  private descriptor(
    detail: AuditEntry['detail'],
  ): AuditDescriptor | null {
    if (detail === null || detail === undefined) return null;
    const parsed = AuditDescriptor.safeParse(detail);
    if (parsed.success) return parsed.data;

    const rejected = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
    const kept = Object.fromEntries(
      Object.entries(detail).filter(([key]) => !rejected.has(key)),
    );
    const safe = AuditDescriptor.safeParse(kept);
    return safe.success
      ? { ...safe.data, descriptor_rejected: [...rejected].join(',').slice(0, 200) }
      : { descriptor_rejected: 'all' };
  }
}
