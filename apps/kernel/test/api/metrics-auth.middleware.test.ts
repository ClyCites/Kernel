import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { MetricsAuthMiddleware } from '../../src/api/metrics-auth.middleware.js';

function request(authorization?: string): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? authorization : undefined,
  } as Request;
}

function response(state: { status?: number; challenge?: string }): Response {
  return {
    setHeader: (_name: string, value: string) => {
      state.challenge = value;
      return {} as Response;
    },
    status: (value: number) => {
      state.status = value;
      return { end: () => undefined } as unknown as Response;
    },
  } as Response;
}

describe('metrics authentication middleware', () => {
  test('hides the route when no credential is configured', () => {
    const middleware = new MetricsAuthMiddleware({ METRICS_BASIC_AUTH: undefined });
    assert.throws(
      () => middleware.use(request(), response({}), (() => {}) as NextFunction),
      NotFoundException,
    );
  });

  test('challenges an incorrect credential', () => {
    const middleware = new MetricsAuthMiddleware({
      METRICS_BASIC_AUTH: 'prometheus:correct-horse',
    });
    const state: { status?: number; challenge?: string } = {};

    middleware.use(
      request('Basic incorrect'),
      response(state),
      (() => assert.fail('must not continue')) as NextFunction,
    );

    assert.equal(state.status, 401);
    assert.equal(state.challenge, 'Basic realm="kernel-metrics"');
  });

  test('allows the configured credential', () => {
    const credential = 'prometheus:correct-horse';
    const middleware = new MetricsAuthMiddleware({
      METRICS_BASIC_AUTH: credential,
    });
    let called = false;

    middleware.use(
      request(`Basic ${Buffer.from(credential).toString('base64')}`),
      response({}),
      (() => {
        called = true;
      }) as NextFunction,
    );

    assert.equal(called, true);
  });
});