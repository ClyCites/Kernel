import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';

import { requestedDataset } from '../../src/api/dataset.js';
import { SandboxDatasetMiddleware } from '../../src/api/sandbox-dataset.middleware.js';
import type { ClientRepository } from '../../src/identity/client.repository.js';

function request(clientId: string, requested: 'live' | 'seed'): Request {
  return {
    header(name: string): string | undefined {
      if (name === 'x-clycites-client-id') return clientId;
      if (name === 'x-clycites-dataset') return requested;
      return undefined;
    },
  } as Request;
}

describe('sandbox dataset middleware', () => {
  test('a seed client cannot select the live corpus', async () => {
    const repository = {
      current: async () => ({ dataset: 'seed' }),
    } as unknown as ClientRepository;
    const middleware = new SandboxDatasetMiddleware(repository);
    const incoming = request('sandbox-client', 'live');
    let continued = false;

    await middleware.use(
      incoming,
      {} as Response,
      (() => {
        continued = true;
      }) as NextFunction,
    );

    assert.equal(continued, true);
    assert.equal(requestedDataset(incoming, true), 'seed');
  });

  test('a live client keeps the ordinary dataset rules', async () => {
    const repository = {
      current: async () => ({ dataset: 'live' }),
    } as unknown as ClientRepository;
    const middleware = new SandboxDatasetMiddleware(repository);
    const incoming = request('live-client', 'live');

    await middleware.use(incoming, {} as Response, (() => {}) as NextFunction);

    assert.equal(requestedDataset(incoming, true), 'live');
  });
});
