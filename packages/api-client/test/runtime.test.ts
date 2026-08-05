import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiClient, ProblemError } from '../src/runtime.js';

test('sends one acting-for party and a correlation id', async () => {
  let request: Request | undefined;
  const client = new ApiClient({
    baseUrl: 'https://kernel.example/v1',
    actingFor: '018f0000-0000-7000-8000-000000000001',
    accessToken: () => 'short-lived-token',
    correlationId: () => 'request-42',
    fetch: async (input) => {
      request = input;
      return Response.json({ records: [], next_cursor: null });
    },
  });

  await client.api.GET('/records');
  assert.equal(request?.headers.get('Authorization'), 'Bearer short-lived-token');
  assert.equal(request?.headers.get('X-Acting-For'), '018f0000-0000-7000-8000-000000000001');
  assert.equal(request?.headers.get('X-Correlation-Id'), 'request-42');
});

test('throws typed RFC 9457 problem details with correlation id', async () => {
  const client = new ApiClient({
    baseUrl: 'https://kernel.example/v1',
    fetch: async () =>
      Response.json(
        { type: '/problems/403', title: 'Forbidden', status: 403 },
        {
          status: 403,
          headers: {
            'content-type': 'application/problem+json',
            'X-Correlation-Id': 'response-7',
          },
        },
      ),
  });

  await assert.rejects(
    client.api.GET('/records'),
    (error: unknown) =>
      error instanceof ProblemError &&
      error.problem.status === 403 &&
      error.correlationId === 'response-7',
  );
});