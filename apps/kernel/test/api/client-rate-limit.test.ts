import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientRateLimitMiddleware } from '../../src/api/rate-limit.middleware.js';
import { CLIENT_HEADER } from '../../src/api/subject.js';

interface FakeResponse {
  headers: Record<string, string>;
  code: number | null;
  setHeader(name: string, value: string): void;
  status(code: number): FakeResponse;
  type(): FakeResponse;
  json(): void;
}

function response(): FakeResponse {
  const value: FakeResponse = {
    headers: {},
    code: null,
    setHeader(name, headerValue) {
      value.headers[name] = headerValue;
    },
    status(code) {
      value.code = code;
      return value;
    },
    type: () => value,
    json: () => {},
  };
  return value;
}

const middleware = (): ClientRateLimitMiddleware =>
  new ClientRateLimitMiddleware({
    REGISTRY_RATE_LIMIT: 1,
    REGISTRY_RATE_WINDOW_SECONDS: 60,
  });

describe('authenticated traffic is limited per client', () => {
  test('a request without a client claim is not charged', () => {
    const limiter = middleware();
    const result = response();
    let passed = 0;

    limiter.use({ headers: {} } as never, result as never, () => {
      passed += 1;
    });

    assert.equal(passed, 1);
    assert.deepEqual(result.headers, {});
  });

  test("one client cannot spend another client's budget", () => {
    const limiter = middleware();
    const request = (clientId: string): never =>
      ({ headers: { [CLIENT_HEADER]: clientId } }) as never;

    limiter.use(request('marketplace'), response() as never, () => {});
    const blocked = response();
    limiter.use(request('marketplace'), blocked as never, () => {});
    const other = response();
    limiter.use(request('lender'), other as never, () => {});

    assert.equal(blocked.code, 429);
    assert.equal(other.code, null);
    assert.equal(other.headers['RateLimit-Remaining'], '0');
  });
});