import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { validate as validateOpenApi } from '@readme/openapi-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { uuidv7 } from 'uuidv7';

import 'reflect-metadata';
import { AppModule } from '../../src/app.module.js';
import { KERNEL_POOL } from '../../src/storage/pool.js';
import { KERNEL_CONFIG } from '../../src/config.js';
import { DEFAULT_MASS_BALANCE_TOLERANCE } from '../../src/records/mass-balance.js';
import { buildOpenApiDocument } from '../../src/api/openapi.js';
import { SUBJECT_HEADER } from '../../src/api/subject.js';
import { LAWFUL_BASIS_HEADER } from '../../src/api/dataset.js';
import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import { deliveryDocument } from '../helpers/fixtures.js';

let db: TestDatabase;
let app: INestApplication;
let base: string;

const document = buildOpenApiDocument();

before(async () => {
  db = await startTestDatabase();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KERNEL_POOL)
    .useValue(db.app)
    // The real provider reads and validates the process environment, which the
    // test harness does not set. The pool is overridden for the same reason.
    .overrideProvider(KERNEL_CONFIG)
    .useValue({ MASS_BALANCE_TOLERANCE: DEFAULT_MASS_BALANCE_TOLERANCE })
    .compile();

  app = moduleRef.createNestApplication();
  app.useLogger(false);
  await app.listen(0);
  base = await app.getUrl();
});

after(async () => {
  await app.close();
  await db.stop();
});

interface Json {
  status: number;
  headers: Headers;
  body: unknown;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  options: { as?: string | null; basis?: string | null } = {},
): Promise<Json> {
  const subject = options.as === undefined ? undefined : options.as;
  // Every write has to declare a DPPA ground — see docs/decisions/0019.
  // Production has no default; this one keeps the tests that are not about the
  // basis from restating it. Pass `basis: null` to exercise its absence.
  const basis = options.basis === undefined ? 'special_data_consent' : options.basis;
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(subject === undefined || subject === null
        ? {}
        : { [SUBJECT_HEADER]: subject }),
      ...(body === undefined || basis === null
        ? {}
        : { [LAWFUL_BASIS_HEADER]: basis }),
    },
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

/** Validates a payload against a schema from the generated document. */
function conforms(schemaName: string, payload: unknown): void {
  const ajv = new Ajv2020({ strict: false, allErrors: true, formats: fullFormats });
  ajv.addSchema({ ...document, $id: 'kernel-openapi' });

  const validate = ajv.compile({
    $ref: `kernel-openapi#/components/schemas/${schemaName}`,
  });

  if (!validate(payload)) {
    assert.fail(
      `${schemaName} did not match the generated schema: ${JSON.stringify(validate.errors)}`,
    );
  }
}

/* ── the document ─────────────────────────────────────────────────────── */

describe('the generated OpenAPI document (brief §5.4)', () => {
  test('it validates as OpenAPI 3.1', async () => {
    const result = await validateOpenApi(structuredClone(document) as never);
    assert.equal(result.valid, true, JSON.stringify(result));
  });

  test('it is generated from the schemas, not written by hand', () => {
    const schemas = (document['components'] as Record<string, unknown>)[
      'schemas'
    ] as Record<string, Record<string, unknown>>;

    const delivery = schemas['Delivery']!;
    const properties = delivery['properties'] as Record<string, unknown>;

    assert.equal((properties['type'] as Record<string, unknown>)['const'], 'delivery');
    assert.equal(
      (properties['record_class'] as Record<string, unknown>)['const'],
      'observation',
    );
    assert.ok(
      properties['quantity'],
      'the body fields come from @clycites/schema, not from a hand-kept list',
    );
  });

  test('every operation documents a problem response', () => {
    const paths = document['paths'] as Record<string, Record<string, unknown>>;
    for (const [path, operations] of Object.entries(paths)) {
      if (path === '/health') continue;
      for (const operation of Object.values(operations)) {
        const responses = (operation as Record<string, unknown>)['responses'] as Record<
          string,
          unknown
        >;
        assert.ok(
          Object.keys(responses).some((status) => Number(status) >= 400),
          `${path} must say how it fails`,
        );
      }
    }
  });
});

/* ── round trip ───────────────────────────────────────────────────────── */

describe('a Delivery round-trips through the public API', () => {
  test('submit, then read back, both conforming to the document', async () => {
    const asserter = uuidv7();
    const submission = deliveryDocument({ asserted_by: asserter });
    conforms('DeliverySubmission', submission);

    const created = await call('POST', '/v1/records', submission);

    assert.equal(created.status, 201);
    assert.equal(created.headers.get('location'), `/v1/records/${submission['id']}`);
    conforms('RecordView', created.body);

    const fetched = await call('GET', `/v1/records/${submission['id']}`, undefined, {
      as: asserter,
    });

    assert.equal(fetched.status, 200);
    conforms('RecordView', fetched.body);

    const view = fetched.body as { record: Record<string, unknown> };
    assert.equal(view.record['id'], submission['id']);
    assert.deepEqual(view.record['quantity'], {
      ...(submission['quantity'] as Record<string, unknown>),
      quality_flags: [],
    });
  });

  test('a replay comes back 200 with the same record', async () => {
    const submission = deliveryDocument();

    const first = await call('POST', '/v1/records', submission);
    const second = await call('POST', '/v1/records', submission);

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
  });

  test('a list conforms to the documented page shape', async () => {
    const asserter = uuidv7();
    await call('POST', '/v1/records', deliveryDocument({ asserted_by: asserter }));

    const page = await call(
      'GET',
      `/v1/records?type=delivery&asserted_by=${asserter}`,
      undefined,
      { as: asserter },
    );

    assert.equal(page.status, 200);
    conforms('Page', page.body);
  });

  test('a chain conforms to the documented chain shape', async () => {
    const asserter = uuidv7();
    const first = deliveryDocument({ asserted_by: asserter, to_party: asserter });
    await call('POST', '/v1/records', first);
    await call(
      'POST',
      '/v1/records',
      deliveryDocument({
        asserted_by: asserter,
        to_party: asserter,
        supersedes: first['id'],
      }),
    );

    const chain = await call('GET', `/v1/records/${first['id']}/chain`, undefined, {
      as: asserter,
    });

    assert.equal(chain.status, 200);
    conforms('Chain', chain.body);
    assert.equal((chain.body as { records: unknown[] }).records.length, 2);
  });
});

/* ── consent ──────────────────────────────────────────────────────────── */

describe('reads are refused without a lawful basis (spec §10)', () => {
  test('an anonymous read of a real record is 403, not 200', async () => {
    const submission = deliveryDocument();
    await call('POST', '/v1/records', submission);

    const response = await call('GET', `/v1/records/${submission['id']}`);

    assert.equal(response.status, 403);
    conforms('Problem', response.body);
    assert.equal(
      (response.body as Record<string, unknown>)['code'],
      'consent_not_implemented',
    );
  });

  test('a stranger cannot read someone else’s record', async () => {
    const submission = deliveryDocument();
    await call('POST', '/v1/records', submission);

    const response = await call('GET', `/v1/records/${submission['id']}`, undefined, {
      as: uuidv7(),
    });

    assert.equal(response.status, 403);
  });

  test('naming a purpose is refused until the consent spec exists', async () => {
    const asserter = uuidv7();
    const submission = deliveryDocument({ asserted_by: asserter });
    await call('POST', '/v1/records', submission);

    const response = await call(
      'GET',
      `/v1/records?type=delivery&asserted_by=${asserter}&purpose=credit_assessment`,
      undefined,
      { as: asserter },
    );

    assert.equal(response.status, 403);
    assert.equal(
      (response.body as Record<string, unknown>)['code'],
      'consent_not_implemented',
    );
  });
});

/* ── problems ─────────────────────────────────────────────────────────── */

describe('errors are RFC 9457 problem details', () => {
  test('a malformed record comes back as 422 with the offending fields', async () => {
    const broken = deliveryDocument();
    delete broken['occurred_at_precision'];

    const response = await call('POST', '/v1/records', broken);

    assert.equal(response.status, 422);
    conforms('Problem', response.body);

    const problem = response.body as Record<string, unknown>;
    assert.equal(problem['code'], 'malformed_record');
    assert.equal(problem['type'], '/problems/malformed_record');
    assert.ok(
      (problem['issues'] as Array<{ path: string }>).some(
        (issue) => issue.path === 'occurred_at_precision',
      ),
    );
  });

  test('an unauthorised delegation comes back as 403', async () => {
    const response = await call(
      'POST',
      '/v1/records',
      deliveryDocument({ on_behalf_of: uuidv7(), delegation: uuidv7() }),
    );

    assert.equal(response.status, 403);
    assert.equal(
      (response.body as Record<string, unknown>)['code'],
      'delegation_not_authorised',
    );
  });

  test('a reused id comes back as 409', async () => {
    const submission = deliveryDocument();
    await call('POST', '/v1/records', submission);

    const response = await call('POST', '/v1/records', {
      ...submission,
      commodity: 'crop.beans.dry',
    });

    assert.equal(response.status, 409);
    assert.equal((response.body as Record<string, unknown>)['code'], 'id_conflict');
  });

  test('a missing record comes back as 404', async () => {
    const response = await call('GET', `/v1/records/${uuidv7()}`);

    assert.equal(response.status, 404);
    conforms('Problem', response.body);
    assert.equal((response.body as Record<string, unknown>)['status'], 404);
  });

  test('problems carry the correlation id and the requested path', async () => {
    const response = await call('GET', `/v1/records/${uuidv7()}`);
    const problem = response.body as Record<string, unknown>;

    assert.equal(problem['correlation_id'], response.headers.get('x-correlation-id'));
    assert.match(String(problem['instance']), /^\/v1\/records\//);
  });
});

/* ── operations ───────────────────────────────────────────────────────── */

describe('liveness and readiness', () => {
  test('health does not touch the database', async () => {
    const response = await call('GET', '/v1/health');
    assert.equal(response.status, 200);
    conforms('Health', response.body);
  });

  test('readiness reports that the log is reachable', async () => {
    const response = await call('GET', '/v1/ready');
    assert.equal(response.status, 200);
    assert.equal((response.body as Record<string, unknown>)['status'], 'ready');
  });

  test('a caller-supplied correlation id is echoed when it is plausible', async () => {
    const ours = await fetch(`${base}/v1/health`, {
      headers: { 'x-correlation-id': 'run-42' },
    });
    assert.equal(ours.headers.get('x-correlation-id'), 'run-42');

    const forged = await fetch(`${base}/v1/health`, {
      headers: { 'x-correlation-id': 'run 42 <script>' },
    });
    assert.notEqual(forged.headers.get('x-correlation-id'), 'run 42 <script>');
  });
});

/* ── sync ─────────────────────────────────────────────────────────────── */

describe('offline devices reach the log through the same API', () => {
  test('a device registers, and registering again is not an error', async () => {
    const registration = {
      device_id: uuidv7(),
      registered_by: uuidv7(),
      label: 'Masaka officer, tablet 4',
    };

    const created = await call('POST', '/v1/devices', registration);
    assert.equal(created.status, 201);
    conforms('Device', created.body);

    const again = await call('POST', '/v1/devices', registration);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, created.body);
  });

  test('an outbox drains with a result per record', async () => {
    const officer = uuidv7();
    const good = deliveryDocument({ asserted_by: officer });
    const bad = deliveryDocument({ asserted_by: officer, commodity: 'maize' });

    const response = await call('POST', '/v1/sync/outbox', [good, bad]);
    assert.equal(response.status, 200);
    conforms('DrainReport', response.body);

    const results = (response.body as { results: { outcome: string }[] }).results;
    assert.deepEqual(
      results.map((result) => result.outcome),
      ['accepted', 'rejected'],
    );

    const stored = await call(
      'GET',
      `/v1/records/${good['id'] as string}`,
      undefined,
      { as: officer },
    );
    assert.equal(stored.status, 200);
  });

  test('changes come back oldest first behind a cursor', async () => {
    const officer = uuidv7();
    for (let i = 0; i < 2; i += 1) {
      await call('POST', '/v1/records', deliveryDocument({ asserted_by: officer }));
    }

    const response = await call('GET', '/v1/sync/changes?limit=1', undefined, {
      as: officer,
    });
    assert.equal(response.status, 200);
    conforms('Changes', response.body);

    const page = response.body as { records: unknown[]; next_cursor: string | null };
    assert.equal(page.records.length, 1);
    assert.notEqual(page.next_cursor, null);

    const next = await call(
      'GET',
      `/v1/sync/changes?limit=1&cursor=${encodeURIComponent(page.next_cursor ?? '')}`,
      undefined,
      { as: officer },
    );
    assert.equal(next.status, 200);
    assert.notDeepEqual(next.body, response.body);
  });

  test('a device pulling without a verified subject gets nothing', async () => {
    const response = await call('GET', '/v1/sync/changes?limit=1');

    assert.equal(response.status, 403);
    conforms('Problem', response.body);
  });

  test('a cursor we did not issue is a 400, not a 500', async () => {
    const response = await call('GET', '/v1/sync/changes?cursor=nonsense', undefined, {
      as: uuidv7(),
    });
    assert.equal(response.status, 400);
    conforms('Problem', response.body);
  });
});

/**
 * A sync page is the largest thing the kernel ever sends and the thing most
 * likely to be pulled over 2G. Records are JSON with long repeated key names,
 * so they compress hard — this is the cheapest bandwidth win available.
 */
describe('responses compress for narrowband clients', () => {
  const raw = async (path: string, as: string, encoding?: string) =>
    fetch(`${base}${path}`, {
      headers: {
        [SUBJECT_HEADER]: as,
        ...(encoding === undefined ? {} : { 'accept-encoding': encoding }),
      },
    });

  // `fetch` decompresses transparently, so the only way to see what actually
  // crossed the wire is to count the bytes off the socket.
  const wireBytes = (path: string, as: string, encoding: string) =>
    new Promise<{ encoding: string | undefined; bytes: number }>(
      (resolve, reject) => {
        const request = get(
          `${base}${path}`,
          { headers: { [SUBJECT_HEADER]: as, 'accept-encoding': encoding } },
          (response) => {
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.byteLength;
            });
            response.on('end', () =>
              resolve({
                encoding: response.headers['content-encoding'],
                bytes,
              }),
            );
          },
        );
        request.on('error', reject);
      },
    );

  test('a sync page comes back gzipped, and much smaller', async () => {
    const officer = uuidv7();
    for (let i = 0; i < 8; i += 1) {
      await call('POST', '/v1/records', deliveryDocument({ asserted_by: officer }));
    }

    const compressed = await wireBytes('/v1/sync/changes?limit=8', officer, 'gzip');
    const plain = await wireBytes('/v1/sync/changes?limit=8', officer, 'identity');

    assert.equal(compressed.encoding, 'gzip');
    assert.equal(plain.encoding, undefined);
    assert.ok(
      compressed.bytes * 2 < plain.bytes,
      `expected at least 2x, got ${plain.bytes} -> ${compressed.bytes} bytes`,
    );
  });

  test('a client that cannot decompress still gets its records', async () => {
    const officer = uuidv7();
    await call('POST', '/v1/records', deliveryDocument({ asserted_by: officer }));

    const response = await raw('/v1/sync/changes?limit=1', officer, 'identity');

    assert.equal(response.status, 200);
    conforms('Changes', await response.json());
  });
});
