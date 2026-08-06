import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { LiveIngestMiddleware } from '../../src/api/live-ingest.middleware.js';

function request(method: string, dataset?: string): Request {
  return {
    method,
    header: (name: string) =>
      name.toLowerCase() === 'x-clycites-dataset' ? dataset : undefined,
  } as Request;
}

function response(headers: Record<string, string> = {}): Response {
  return {
    setHeader: (name: string, value: string | number | readonly string[]) => {
      headers[name.toLowerCase()] = String(value);
      return {} as Response;
    },
  } as Response;
}

describe('live ingest middleware', () => {
  test('refuses every live mutation when the staging guard is active', () => {
    const middleware = new LiveIngestMiddleware({
      LIVE_INGEST_ENABLED: false,
      SEED_INGEST_ENABLED: true,
    });
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE'];

    for (const method of methods) {
      const headers: Record<string, string> = {};
      assert.throws(
        () =>
          middleware.use(
            request(method),
            response(headers),
            (() => {}) as NextFunction,
          ),
        ServiceUnavailableException,
      );
      assert.equal(headers['x-live-ingest-disabled'], 'true');
    }
  });

  test('allows reads and explicitly enabled seed mutations', () => {
    const middleware = new LiveIngestMiddleware({
      LIVE_INGEST_ENABLED: false,
      SEED_INGEST_ENABLED: true,
    });
    let calls = 0;
    const next = (() => {
      calls += 1;
    }) as NextFunction;

    middleware.use(request('GET'), response(), next);
    middleware.use(request('POST', 'seed'), response(), next);

    assert.equal(calls, 2);
  });

  test('defaults to normal live mutation behavior when enabled', () => {
    const middleware = new LiveIngestMiddleware({
      LIVE_INGEST_ENABLED: true,
      SEED_INGEST_ENABLED: false,
    });
    let called = false;

    middleware.use(request('POST'), response(), (() => {
      called = true;
    }) as NextFunction);

    assert.equal(called, true);
  });
});