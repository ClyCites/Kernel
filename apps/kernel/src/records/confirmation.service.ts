import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { SCHEMA_VERSION } from '@clycites/schema';
import { uuidv7 } from 'uuidv7';

import { IngestService } from './ingest.service.js';
import { RecordRepository } from './record.repository.js';
import type { Dataset } from './record.js';

export interface ConfirmRequest {
  delivery: string;
  /** The authenticated caller. The gateway has already checked the PIN. */
  assertedBy: string;
  /** Set only when somebody is confirming for the counterparty. */
  onBehalfOf?: string | null | undefined;
  delegation?: string | null | undefined;
  channel: string;
  note?: string | null | undefined;
  occurredAt?: string | undefined;
  dataset: Dataset;
  correlationId?: string | null | undefined;
}

export interface ConfirmResult {
  id: string;
  delivery: string;
  confirming_party: string;
  confirmed_at: string;
  /** Somebody confirmed for the counterparty rather than the counterparty. */
  delegated: boolean;
  quality_flags: string[];
}

/**
 * Confirming a delivery, in one call.
 *
 * The counterparty is a smallholder on a feature phone. Everything a
 * `delivery_confirmation` needs beyond "which delivery" and "who is speaking"
 * is derivable, so the kernel derives it rather than asking a USSD gateway to
 * mint uuidv7s, track schema versions and pick a lawful basis. The gateway
 * authenticates the PIN and calls this; that is the whole adapter.
 *
 * The ground is inherited from the delivery being confirmed. A confirmation is
 * held for exactly the reason the delivery is held, and letting a caller state
 * a different one would let a s.9 delivery grow a s.7 shadow.
 */
@Injectable()
export class ConfirmationService {
  constructor(
    @Inject(IngestService) private readonly ingest: IngestService,
    @Inject(RecordRepository) private readonly repository: RecordRepository,
  ) {}

  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    const delivery = await this.repository.findById(request.delivery);
    if (
      !delivery ||
      delivery.dataset !== request.dataset ||
      delivery.type !== 'delivery'
    ) {
      throw new NotFoundException(`no delivery ${request.delivery}`);
    }

    const confirming = request.onBehalfOf ?? request.assertedBy;
    const occurredAt = request.occurredAt ?? new Date().toISOString();

    const result = await this.ingest.ingest(
      {
        id: uuidv7(),
        type: 'delivery_confirmation',
        record_class: 'observation',
        schema_version: SCHEMA_VERSION,
        occurred_at: occurredAt,
        // A confirmation happens at a moment — somebody pressed a key. It is
        // not a day-precision fact like a harvest.
        occurred_at_precision: 'instant',
        asserted_by: request.assertedBy,
        on_behalf_of: request.onBehalfOf ?? null,
        delegation: request.delegation ?? null,
        lawful_basis: delivery.lawful_basis,
        delivery: request.delivery,
        confirming_party: confirming,
        channel: request.channel,
        note: request.note ?? null,
      },
      {
        dataset: request.dataset,
        correlationId: request.correlationId ?? null,
      },
    );

    return {
      id: result.record.id,
      delivery: request.delivery,
      confirming_party: confirming,
      confirmed_at: result.record.occurred_at,
      delegated: result.record.on_behalf_of !== null,
      quality_flags: result.record.quality_flags,
    };
  }
}
