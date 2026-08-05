import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfirmationChannel } from '@clycites/schema';
import { z } from 'zod';

import { ConfirmationService } from '../records/confirmation.service.js';
import { verifiedSubject } from './subject.js';
import { correlationOf } from './correlation.middleware.js';
import { requestedDataset } from './dataset.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

/**
 * Everything the caller supplies. Deliberately short: the id, the schema
 * version, the lawful basis and the confirming party are all derivable, and a
 * USSD gateway that had to get four more fields right is a gateway that will
 * get them wrong.
 */
const Confirm = z.object({
  channel: ConfirmationChannel,
  note: z.string().max(500).nullable().optional(),
  /** Present only when a delegate is confirming for the counterparty. */
  on_behalf_of: z.uuid().nullable().optional(),
  delegation: z.uuid().nullable().optional(),
  /** For a confirmation captured offline. Defaults to now. */
  occurred_at: z.iso.datetime({ offset: true }).optional(),
});

const Id = z.uuid();

@Controller('v1')
export class ConfirmationsController {
  constructor(
    @Inject(ConfirmationService)
    private readonly confirmations: ConfirmationService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Post('deliveries/:id/confirmation')
  async confirm(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const delivery = Id.safeParse(id);
    if (!delivery.success) throw new BadRequestException(`${id} is not a record id`);

    const parsed = Confirm.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      );
    }

    if (parsed.data.on_behalf_of != null && parsed.data.delegation == null) {
      throw new BadRequestException(
        'confirming for another party requires the delegation that authorises it',
      );
    }

    // There is no anonymous version of this act: a confirmation whose author
    // is unknown is the self-attestation it exists to replace.
    const assertedBy = verifiedSubject(request);
    if (assertedBy === null) {
      throw new UnauthorizedException('a confirmation must say who is confirming');
    }

    return this.confirmations.confirm({
      delivery: delivery.data,
      assertedBy,
      onBehalfOf: parsed.data.on_behalf_of ?? null,
      delegation: parsed.data.delegation ?? null,
      channel: parsed.data.channel,
      note: parsed.data.note ?? null,
      occurredAt: parsed.data.occurred_at,
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      correlationId: correlationOf(request),
    });
  }
}
