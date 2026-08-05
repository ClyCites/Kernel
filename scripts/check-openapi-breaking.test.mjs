import assert from 'node:assert/strict';
import { test } from 'node:test';

import { changedExistingContracts } from './check-openapi-breaking.mjs';

const base = {
  paths: { '/v1/records': { get: { responses: { 200: {} } } } },
  components: {
    schemas: {
      Record: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  },
};

test('new paths and schemas are additive', () => {
  const head = structuredClone(base);
  head.paths['/v1/clients'] = { post: {} };
  head.components.schemas.Client = { type: 'object' };
  assert.deepEqual(changedExistingContracts(base, head), []);
});

test('a deliberately breaking schema change fails the semantic gate', () => {
  const head = structuredClone(base);
  head.components.schemas.Record.required.push('type');
  assert.deepEqual(changedExistingContracts(base, head), ['schemas.Record']);
});

test('removing an endpoint fails the semantic gate', () => {
  const head = structuredClone(base);
  delete head.paths['/v1/records'];
  assert.deepEqual(changedExistingContracts(base, head), ['paths./v1/records']);
});