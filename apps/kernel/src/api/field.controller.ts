import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { FieldService } from '../field/field.service.js';
import { ClientService, type ClientRequestContext } from '../identity/client.service.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import { requestedDataset } from './dataset.js';
import { actingFor, verifiedClient, verifiedSubject } from './subject.js';

const ConfirmationRequest = z.object({ delivery: z.uuid() });
const Flow = z.enum(['enrolment', 'delivery', 'confirmation', 'calibration', 'media', 'sync']);
const FieldEvent = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('delegation_basis'),
    choice: z.enum(['witnessed_in_person', 'ussd_confirmation', 'organisational_bylaw']),
  }).strict(),
  z.object({
    event: z.literal('name_collision'),
    choice: z.enum(['created_separate', 'same_as_linked', 'kept_separate']),
  }).strict(),
  z.object({
    event: z.literal('season_label'),
    choice: z.enum(['registry_label', 'officer_label', 'no_label']),
  }).strict(),
  z.object({
    event: z.literal('missing_field'),
    choice: z.literal('unsupported'),
    flow: Flow,
    step: z.string().regex(/^[a-z0-9_]{1,80}$/),
  }).strict(),
  z.object({
    event: z.literal('flow_abandoned'),
    choice: z.literal('abandoned'),
    flow: Flow,
    step: z.string().regex(/^[a-z0-9_]{1,80}$/),
  }).strict(),
]);

@Controller('v1/field')
export class FieldController {
  constructor(
    @Inject(FieldService) private readonly field: FieldService,
    @Inject(ClientService) private readonly clients: ClientService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'SEED_INGEST_ENABLED'> = {
      SEED_INGEST_ENABLED: false,
    },
  ) {}

  @Post('confirmation-requests')
  async requestConfirmation(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    const parsed = ConfirmationRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('delivery must be a record id');
    const client = await this.client(request, 'records:write');
    return this.field.requestConfirmation({
      delivery: parsed.data.delivery,
      requester: client.requester,
      clientId: client.clientId,
      dataset: requestedDataset(request, this.config.SEED_INGEST_ENABLED),
    });
  }

  @Get('confirmation-requests')
  async confirmations(@Req() request: Request): Promise<unknown> {
    const client = await this.client(request, 'records:read');
    return {
      requests: await this.field.confirmationRequests(
        client.requester,
        requestedDataset(request, this.config.SEED_INGEST_ENABLED),
      ),
    };
  }

  @Post('events')
  async event(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    const parsed = FieldEvent.safeParse(body);
    if (!parsed.success) throw new BadRequestException('unknown field event');
    const client = await this.client(request, 'sync');
    return this.field.recordEvent({
      clientId: client.clientId,
      actingFor: client.actingFor,
      event: parsed.data,
    });
  }

  private async client(
    request: Request,
    scope: 'records:read' | 'records:write' | 'sync',
  ): Promise<ClientRequestContext> {
    const client = await this.clients.resolve(
      verifiedSubject(request),
      verifiedClient(request),
      actingFor(request),
      scope,
    );
    if (client === null) throw new ForbiddenException('a field client is required');
    return client;
  }
}