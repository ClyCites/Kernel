import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildOpenApiDocument } from '../../src/api/openapi.js';

describe('sandbox registration OpenAPI', () => {
  test('publishes the Authentik-backed registration operation', () => {
    const document = buildOpenApiDocument();
    const paths = document.paths as Record<string, unknown>;
    assert.ok(paths['/clients/sandbox/registrations']);
  });
});
