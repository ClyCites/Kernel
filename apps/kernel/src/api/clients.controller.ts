import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { CLIENT_SCOPES } from '../identity/client.repository.js';
import { ClientService } from '../identity/client.service.js';
import { verifiedSubject } from './subject.js';
import { DelegationService } from '../records/delegation.service.js';
import { verifiedClient } from './subject.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

const Authorisation = z.object({
  client_id: z.string().min(1).max(200),
  scopes: z.array(z.enum(CLIENT_SCOPES)).min(1),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  granted_via: z.string().min(1).max(100),
});

const Revocation = z.object({
  on_behalf_of: z.uuid().optional(),
  delegation: z.uuid().optional(),
  reason: z.string().max(500).nullable().optional(),
});

const SandboxRegistration = z.object({
  display_name: z.string().min(1).max(200),
  terms_accepted: z.literal(true),
  terms_version: z.string().min(1).max(100),
});

const EMAIL_VERIFIED_HEADER = 'x-clycites-email-verified';

@Controller('v1/clients')
export class ClientsController {
  constructor(
    @Inject(ClientService) private readonly clients: ClientService,
    @Inject(DelegationService) private readonly delegations: DelegationService,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<
      KernelConfig,
      'SANDBOX_ENABLED' | 'SANDBOX_TERMS_VERSION'
    >,
  ) {}

  @Post('sandbox/registrations')
  async registerSandbox(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const parsed = SandboxRegistration.safeParse(body);
    const subject = verifiedSubject(request);
    const clientId = verifiedClient(request);
    if (
      !parsed.success ||
      !this.config.SANDBOX_ENABLED ||
      subject === null ||
      clientId === null ||
      request.header(EMAIL_VERIFIED_HEADER) !== 'true' ||
      parsed.data.terms_version !== this.config.SANDBOX_TERMS_VERSION
    ) {
      throw new ForbiddenException('verified sandbox registration required');
    }
    const client = await this.clients.registerSandbox({
      clientId,
      displayName: parsed.data.display_name,
      developerSubject: subject,
      termsVersion: parsed.data.terms_version,
    });
    response.status(201);
    return {
      client_id: client.client_id,
      dataset: client.dataset,
      scopes: client.scopes,
      terms_version: parsed.data.terms_version,
    };
  }

  @Get('authorisations')
  async held(@Req() request: Request): Promise<unknown> {
    return { authorisations: await this.clients.authorisations(this.subject(request)) };
  }

  @Post('authorisations')
  async authorise(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    const party = this.subject(request);
    const parsed = Authorisation.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid client authorisation');
    return this.clients.authorise({
      party,
      clientId: parsed.data.client_id,
      scopes: parsed.data.scopes,
      expiresAt: parsed.data.expires_at ?? null,
      grantedVia: parsed.data.granted_via,
    });
  }

  @Delete('authorisations/:id')
  async revoke(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<unknown> {
    const parsed = Revocation.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('invalid revocation');
    const requester = this.subject(request);
    const party = parsed.data.on_behalf_of ?? requester;
    if (party !== requester) {
      if (parsed.data.delegation === undefined) {
        throw new BadRequestException('delegated revocation requires a delegation');
      }
      await this.delegations.authorise({
        delegation: parsed.data.delegation,
        delegator: party,
        delegate: requester,
        recordType: 'client_authorisation',
        occurredAt: new Date().toISOString(),
      });
    }
    const revoked = await this.clients.revoke(
      id,
      party,
      requester,
      parsed.data.reason ?? null,
    );
    if (!revoked) throw new NotFoundException('no authorisation');
    return { revoked: true };
  }

  private subject(request: Request): string {
    const subject = verifiedSubject(request);
    if (subject === null) throw new ForbiddenException('party authentication required');
    return subject;
  }
}