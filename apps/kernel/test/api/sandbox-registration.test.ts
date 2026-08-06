import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';

import { ClientsController } from '../../src/api/clients.controller.js';
import type { ClientService } from '../../src/identity/client.service.js';
import type { DelegationService } from '../../src/records/delegation.service.js';

function request(headers: Record<string, string>): Request {
  return {
    header: (name: string) => headers[name],
  } as Request;
}

describe('sandbox self-registration', () => {
  test('requires verified email and current terms without issuing credentials', async () => {
    const developer = uuidv7();
    const captured: unknown[] = [];
    const clients = {
      registerSandbox: async (input: unknown) => {
        captured.push(input);
        return {
          client_id: 'sandbox-client',
          dataset: 'seed',
          scopes: ['records:read'],
        };
      },
    } as unknown as ClientService;
    const controller = new ClientsController(
      clients,
      {} as DelegationService,
      { SANDBOX_ENABLED: true, SANDBOX_TERMS_VERSION: '2026-08-06' },
    );
    let responseStatus = 200;
    const response = {
      status(code: number) {
        responseStatus = code;
        return this;
      },
    } as Response;
    const verified = request({
      'x-clycites-subject': developer,
      'x-clycites-client-id': 'sandbox-client',
      'x-clycites-email-verified': 'true',
    });

    const result = await controller.registerSandbox(
      {
        display_name: 'Developer sandbox',
        terms_accepted: true,
        terms_version: '2026-08-06',
      },
      verified,
      response,
    );

    assert.equal(responseStatus, 201);
    assert.deepEqual(captured, [
      {
        clientId: 'sandbox-client',
        displayName: 'Developer sandbox',
        developerSubject: developer,
        termsVersion: '2026-08-06',
      },
    ]);
    assert.deepEqual(result, {
      client_id: 'sandbox-client',
      dataset: 'seed',
      scopes: ['records:read'],
      terms_version: '2026-08-06',
    });
    assert.equal(JSON.stringify(result).includes('secret'), false);

    await assert.rejects(
      controller.registerSandbox(
        {
          display_name: 'Developer sandbox',
          terms_accepted: true,
          terms_version: '2026-08-06',
        },
        request({
          'x-clycites-subject': developer,
          'x-clycites-client-id': 'sandbox-client',
          'x-clycites-email-verified': 'false',
        }),
        response,
      ),
      ForbiddenException,
    );
  });
});
