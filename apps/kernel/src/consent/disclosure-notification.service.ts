import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { DisclosureRepository } from '../audit/disclosure.repository.js';
import { RecordRepository } from '../records/record.repository.js';
import { partiesOf } from '../records/subjects.js';
import { toDocument, type StoredRecord } from '../records/record.js';
import {
  DisclosureNotificationRepository,
  type NotificationRow,
} from './disclosure-notification.repository.js';

/**
 * s.16(4). When a record is corrected or retracted, everyone who was shown the
 * old version has to be told.
 *
 * This raises the obligation; it does not discharge it. Delivery is an adapter
 * concern — SMS, USSD, email, a buyer's webhook — and putting any of that in
 * the kernel would mean the kernel had opinions about phone networks. What the
 * kernel owes is that the obligation exists, is attributable, and is countable
 * while it is outstanding.
 *
 * There is no audit entry for raising one. `audit.entry` records access
 * decisions, and this is not one; the notification row is itself the record,
 * and it is append-only for the same reasons the log is.
 *
 * See docs/decisions/0032-disclosure-notification.md.
 */
@Injectable()
export class DisclosureNotificationService {
  constructor(
    @Inject(RecordRepository) private readonly records: RecordRepository,
    @Inject(DisclosureRepository) private readonly disclosures: DisclosureRepository,
    @Inject(DisclosureNotificationRepository)
    private readonly notifications: DisclosureNotificationRepository,
  ) {}

  /**
   * Called with every record that lands. Most are not corrections and cost one
   * field test; the ones that are cost a lookup and a grouped read of the log.
   *
   * Safe to call again for a replayed id — the unique index in 0024 makes a
   * second raise a no-op rather than a second obligation.
   */
  async raiseFor(correction: StoredRecord): Promise<NotificationRow[]> {
    const correctedId = correctedBy(correction);
    if (correctedId === null) return [];

    const corrected = await this.records.findById(correctedId);
    // Ingest has already refused a correction pointing outside its own corpus,
    // so this is belt and braces rather than a case that arrives.
    if (!corrected || corrected.dataset !== correction.dataset) return [];

    const recipients = await this.disclosures.recipientsOf(
      correctedId,
      correction.dataset,
      insiders(corrected, correction),
    );

    return this.notifications.raise(
      recipients.map((row) => ({
        id: uuidv7(),
        recordId: correctedId,
        correctionId: correction.id,
        recipient: row.recipient,
        dataset: correction.dataset,
      })),
    );
  }
}

/** The record this one replaces, whether by superseding it or retracting it. */
function correctedBy(record: StoredRecord): string | null {
  if (record.supersedes !== null) return record.supersedes;
  if (record.type !== 'retraction') return null;
  const target = record.body['target'];
  return typeof target === 'string' ? target : null;
}

/**
 * Parties whose reads were never disclosures: the ones the record is about,
 * the party who asserted it, and whoever wrote the correction.
 *
 * Deliberately only what the two records name directly. A party reached in a
 * hop — the holder of the plot a harvest sits on — is not excluded, so they
 * may get a notification about a correction they are close to. That is noise;
 * a missing notification is a breach, and the two errors are not comparable.
 */
function insiders(corrected: StoredRecord, correction: StoredRecord): string[] {
  return [
    ...partiesOf(toDocument(corrected)),
    corrected.asserted_by,
    corrected.on_behalf_of,
    correction.asserted_by,
    correction.on_behalf_of,
  ].filter((party): party is string => party !== null);
}
