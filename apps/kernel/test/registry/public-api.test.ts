import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

import 'reflect-metadata';
import { AppModule } from '../../src/app.module.js';
import { KERNEL_POOL } from '../../src/storage/pool.js';
import { KERNEL_CONFIG } from '../../src/config.js';
import { DEFAULT_MASS_BALANCE_TOLERANCE } from '../../src/records/mass-balance.js';
import { RateLimitMiddleware } from '../../src/api/rate-limit.middleware.js';
import { SUBJECT_HEADER } from '../../src/api/subject.js';
import { startTestDatabase, sqlState, type TestDatabase } from '../helpers/database.js';

/**
 * The registry is the only surface a third party can read without our
 * permission, and that is the point of it. A delivery says "12 bag = 1200 kg,
 * conversion 019f…0051". Until this endpoint existed, the number 100 was
 * something the reader had to accept from us. These tests are about whether a
 * stranger can now check it instead.
 *
 * Work order K. See docs/decisions/0024-registry-read-api.md.
 */

let db: TestDatabase;
let app: INestApplication;
let base: string;

/** Migration 0015: the superseding row that carries its own weighings. */
const MEASURED = '019fc600-0000-7000-8000-000000000051';
/** Migration 0014: the same factor, before anyone recorded the evidence. */
const SUPERSEDED = '019fc600-0000-7000-8000-000000000050';
/** Migration 0010: the conventional 100 kg bag nobody has checked. */
const ASSUMED = '019fc600-0000-7000-8000-000000000020';

before(async () => {
  db = await startTestDatabase();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KERNEL_POOL)
    .useValue(db.app)
    .overrideProvider(KERNEL_CONFIG)
    .useValue({
      MASS_BALANCE_TOLERANCE: DEFAULT_MASS_BALANCE_TOLERANCE,
      REGISTRY_RATE_LIMIT: 600,
      REGISTRY_RATE_WINDOW_SECONDS: 60,
      REGISTRY_CACHE_SECONDS: 600,
      PUBLIC_BASE_URL: 'https://registry.example',
    })
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
  body: Record<string, unknown>;
}

/** Deliberately sends no subject header. That is the property under test. */
async function anonymous(path: string): Promise<Json> {
  const response = await fetch(`${base}/v1/registry${path}`);
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('a stranger can dereference a conversion factor', () => {
  test('without a subject, a credential, or a consent grant', async () => {
    const response = await anonymous(`/conversions/${MEASURED}`);

    assert.equal(response.status, 200);
    assert.equal(response.body['factor'], 100);
    assert.equal(response.body['from_unit'], 'bag');
    assert.equal(response.body['to_unit'], 'kg');
    assert.equal(response.body['commodity'], 'crop.maize.grain');
  });

  test('the basis is stated, not implied', async () => {
    const measured = await anonymous(`/conversions/${MEASURED}`);
    const assumed = await anonymous(`/conversions/${ASSUMED}`);

    assert.equal(measured.body['basis'], 'measured');
    assert.equal(assumed.body['basis'], 'assumed_default');

    // Same factor, same units, same commodity. The only thing separating a
    // weight somebody stood over from a number in circulation is this field,
    // which is why it has to be reachable.
    assert.equal(measured.body['factor'], assumed.body['factor']);
  });

  test('a measured factor shows the individual weighings', async () => {
    const response = await anonymous(`/conversions/${MEASURED}`);
    const sample = response.body['sample'] as {
      ordinal: number;
      weight_kg: number;
      condition: string | null;
    }[];

    assert.equal(sample.length, 12);
    assert.equal(sample.length, response.body['sample_size']);
    assert.deepEqual(
      sample.map((s) => s.ordinal),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );

    // The summary statistics have to be recomputable from the rows, or the
    // summary is a second, unverifiable claim rather than a restatement.
    const weights = sample.map((s) => s.weight_kg);
    assert.equal(Math.min(...weights), Number(response.body['sample_min']));
    assert.equal(Math.max(...weights), Number(response.body['sample_max']));
  });

  test('the sample carries per-weighing conditions', async () => {
    const response = await anonymous(`/conversions/${MEASURED}`);
    const sample = response.body['sample'] as { condition: string | null }[];
    const damp = sample.filter((s) => s.condition === 'damp,tight');

    // Two of the twelve were damp. That is not a defect in the data — it is
    // the explanation for a 2.68 kg standard deviation, and a summary that
    // said only `dried,tight` would have hidden it.
    assert.equal(damp.length, 2);
  });

  test('who weighed, when, and on what are all answerable', async () => {
    const response = await anonymous(`/conversions/${MEASURED}`);

    assert.match(String(response.body['measured_by']), /Cooperative/);
    assert.match(String(response.body['measured_at']), /^2026-07-14T/);
    assert.match(String(response.body['instrument']), /platform scale/);
  });

  test('a conversion carries a permanent URL and citation line', async () => {
    const response = await anonymous(`/conversions/${MEASURED}`);

    assert.equal(
      response.body['permanent_url'],
      `https://registry.example/v1/registry/conversions/${MEASURED}`,
    );
    assert.match(String(response.body['citation']), /as at \d{4}-\d{2}-\d{2}/u);
    assert.match(String(response.body['citation']), new RegExp(MEASURED, 'u'));
  });

  test('an unverified factor claims no evidence it does not have', async () => {
    const response = await anonymous(`/conversions/${ASSUMED}`);

    assert.equal(response.body['sample_size'], null);
    assert.deepEqual(response.body['sample'], []);
    assert.equal(response.body['measured_by'], null);
    assert.equal(response.body['instrument'], null);
  });

  test('a superseded factor is still readable, and says what replaced it', async () => {
    // A record written last month cites 0050. If that id stopped resolving,
    // the record would become uncheckable — which is the failure an append-only
    // registry exists to avoid.
    const old = await anonymous(`/conversions/${SUPERSEDED}`);
    assert.equal(old.status, 200);
    assert.deepEqual(old.body['sample'], []);

    const current = await anonymous(`/conversions/${MEASURED}`);
    assert.equal(current.body['supersedes'], SUPERSEDED);
  });

  test('an id that is not a conversion is a 404, not a 500', async () => {
    const missing = await anonymous('/conversions/019fc600-0000-7000-8000-999999999999');
    assert.equal(missing.status, 404);

    const nonsense = await anonymous('/conversions/not-a-uuid');
    assert.equal(nonsense.status, 404);
  });
});

describe('the collections are filterable', () => {
  test('by unit, commodity and basis', async () => {
    const byUnit = await anonymous('/conversions?from_unit=bag&to_unit=kg');
    const conversions = byUnit.body['conversions'] as Record<string, unknown>[];
    assert.ok(conversions.length > 0);
    assert.ok(conversions.every((c) => c['from_unit'] === 'bag'));

    const byBasis = await anonymous('/conversions?basis=measured&commodity=crop.maize.grain');
    const measured = byBasis.body['conversions'] as Record<string, unknown>[];
    assert.ok(measured.length > 0);
    assert.ok(measured.every((c) => c['basis'] === 'measured'));
  });

  test('a collection does not carry the sample rows', async () => {
    // A lender filtering a list does not need 12 rows per factor; a scraper
    // would like them very much. The sample is one fetch away by id.
    const list = await anonymous('/conversions?limit=100');
    const conversions = list.body['conversions'] as Record<string, unknown>[];
    assert.ok(conversions.every((c) => !('sample' in c)));
  });

  test('the index states uncertainty and counts each evidence basis', async () => {
    const list = await anonymous('/conversions?limit=100');
    const counts = list.body['basis_counts'] as Record<string, number>;

    assert.match(String(list.body['uncertainty_notice']), /assumptions/u);
    assert.equal(list.body['license'], 'https://creativecommons.org/publicdomain/zero/1.0/');
    assert.ok(counts['measured']! > 0);
    assert.ok(counts['assumed_default']! > 0);
    assert.ok(counts['published_standard']! > 0);
  });

  test('a limit beyond the ceiling is refused rather than quietly clamped', async () => {
    const response = await anonymous('/conversions?limit=5000');
    assert.equal(response.status, 400);
  });

  test('the rest of the vocabulary is readable too', async () => {
    const types = await anonymous('/observation-types');
    assert.ok((types.body['observation_types'] as unknown[]).length > 0);

    const crops = await anonymous('/crop-codes');
    assert.ok((crops.body['crop_codes'] as unknown[]).length > 0);

    const regions = await anonymous('/admin-regions');
    assert.ok((regions.body['admin_regions'] as unknown[]).length > 0);

    const schemes = await anonymous('/grading-schemes');
    assert.ok((schemes.body['grading_schemes'] as unknown[]).length > 0);

    const cropsAlias = await anonymous('/crops');
    const regionsAlias = await anonymous('/regions');
    assert.deepEqual(cropsAlias.body, crops.body);
    assert.deepEqual(regionsAlias.body, regions.body);
  });

  test('bulk JSON and CSV carry complete conversion evidence', async () => {
    const json = await anonymous('/conversions.json');
    const conversions = json.body['conversions'] as Record<string, unknown>[];
    const measured = conversions.find((row) => row['id'] === MEASURED);

    assert.ok(measured);
    assert.equal((measured['sample'] as unknown[]).length, 12);
    assert.match(String(measured['measured_by']), /Cooperative/u);
    assert.equal(measured['basis'], 'measured');

    const csv = await fetch(`${base}/v1/registry/conversions.csv`);
    const text = await csv.text();
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /^text\/csv/u);
    assert.match(text, /permanent_url,citation/u);
    assert.match(text, new RegExp(MEASURED, 'u'));
    assert.match(text, /damp,tight/u);
  });

  test('dataset.json is a CC0 DCAT descriptor for both distributions', async () => {
    const descriptor = await anonymous('/dataset.json');
    const distributions = descriptor.body['dcat:distribution'] as Record<
      string,
      string
    >[];

    assert.equal(descriptor.body['@type'], 'dcat:Dataset');
    assert.equal(
      descriptor.body['dct:license'],
      'https://creativecommons.org/publicdomain/zero/1.0/',
    );
    assert.deepEqual(
      distributions.map((entry) => entry['dcat:accessURL']),
      [
        'https://registry.example/v1/registry/conversions.json',
        'https://registry.example/v1/registry/conversions.csv',
      ],
    );
  });

  test('a grading scheme comes with the values it permits', async () => {
    const list = await anonymous('/grading-schemes');
    const schemes = list.body['grading_schemes'] as { scheme: string }[];
    const one = await anonymous(`/grading-schemes/${schemes[0]?.scheme}`);

    assert.equal(one.status, 200);
    assert.ok((one.body['values'] as unknown[]).length > 0);
  });

  test('a region cannot be fetched without its boundary vintage', async () => {
    const list = await anonymous('/admin-regions?level=district&limit=1');
    const [region] = list.body['admin_regions'] as {
      code: string;
      vintage: string;
    }[];
    assert.ok(region);

    const found = await anonymous(`/admin-regions/${region.code}/${region.vintage}`);
    assert.equal(found.status, 200);

    // Districts subdivide. The same code at a different vintage is a
    // different place, so there is no route that takes the code alone.
    const bare = await anonymous(`/admin-regions/${region.code}`);
    assert.equal(bare.status, 404);
  });

  test('responses say they can be cached, because the rows cannot change', async () => {
    const response = await anonymous(`/conversions/${MEASURED}`);
    assert.match(response.headers.get('cache-control') ?? '', /public/);
    assert.match(response.headers.get('cache-control') ?? '', /immutable/);
  });
});

describe('opening the registry opens nothing else', () => {
  test('no record is reachable without a subject', async () => {
    const response = await fetch(`${base}/v1/records`);
    const body = (await response.json()) as { records: unknown[] };

    // The list route answers rather than refusing, and answers with nothing:
    // an anonymous caller is a requester the consent guard permits no record
    // to. Empty is the assertion that matters — a 403 would be tidier and a
    // 200 carrying one row would be a breach.
    assert.deepEqual(body.records, []);
  });

  test('the subject header is ignored here rather than honoured', async () => {
    // If the registry ever started varying by subject it would be personal
    // data by another name, and caching it publicly would be a disclosure.
    const plain = await anonymous(`/conversions/${MEASURED}`);
    const withSubject = await fetch(`${base}/v1/registry/conversions/${MEASURED}`, {
      headers: { [SUBJECT_HEADER]: '019b76da-a815-768f-9ad6-b221863c42fb' },
    });

    assert.equal(withSubject.status, 200);
    assert.deepEqual(await withSubject.json(), plain.body);
  });
});

describe('the sample rows are held to the same rules as everything else', () => {
  test('the kernel role can read them and cannot write them', async () => {
    const read = await db.app.query('select count(*) from registry.unit_conversion_sample');
    assert.ok(Number(read.rows[0].count) >= 12);

    await assert.rejects(
      () =>
        db.app.query(
          `insert into registry.unit_conversion_sample (conversion, ordinal, weight_kg)
           values ($1, 99, 100)`,
          [MEASURED],
        ),
      (error: unknown) => sqlState(error) === '42501',
      'the running kernel must not be able to invent a weighing',
    );
  });

  test('even the owner cannot edit a weighing after the fact', async () => {
    // The whole apparatus is worthless if a bad number can be tidied up later.
    await assert.rejects(
      () =>
        db.owner.query(
          'update registry.unit_conversion_sample set weight_kg = 100 where ordinal = 1',
        ),
      (error: unknown) => sqlState(error) === '2F004' || /append-only/.test(String(error)),
    );

    await assert.rejects(
      () => db.owner.query('delete from registry.unit_conversion_sample where ordinal = 1'),
      (error: unknown) => sqlState(error) === '2F004' || /append-only/.test(String(error)),
    );
  });

  test('a sample cannot exceed the size the factor declares', async () => {
    await assert.rejects(
      () =>
        db.owner.query(
          `insert into registry.unit_conversion_sample (conversion, ordinal, weight_kg)
           values ($1, 13, 100)`,
          [MEASURED],
        ),
      /out of range/,
      'thirteen weighings behind a factor that claims twelve is a lie the database should refuse',
    );
  });

  test('a factor claiming no sample cannot acquire one', async () => {
    await assert.rejects(
      () =>
        db.owner.query(
          `insert into registry.unit_conversion_sample (conversion, ordinal, weight_kg)
           values ($1, 1, 100)`,
          [ASSUMED],
        ),
      /declares no sample|sample_size/,
    );
  });
});

describe('the open surface is limited', () => {
  const middleware = (limit: number): RateLimitMiddleware =>
    new RateLimitMiddleware({
      REGISTRY_RATE_LIMIT: limit,
      REGISTRY_RATE_WINDOW_SECONDS: 60,
    });

  interface FakeResponse {
    headers: Record<string, string>;
    code: number | null;
    setHeader(name: string, value: string): void;
    status(code: number): FakeResponse;
    type(): FakeResponse;
    json(): void;
  }

  const fakeResponse = (): FakeResponse => {
    const response: FakeResponse = {
      headers: {},
      code: null,
      setHeader(name, value) {
        response.headers[name] = value;
      },
      status(code) {
        response.code = code;
        return response;
      },
      type: () => response,
      json: () => {},
    };
    return response;
  };

  test('a caller within the window passes through and is told its budget', () => {
    const limiter = middleware(3);
    const response = fakeResponse();
    let passed = 0;

    limiter.use({ ip: '10.0.0.1' } as never, response as never, () => {
      passed += 1;
    });

    assert.equal(passed, 1);
    assert.equal(response.headers['RateLimit-Limit'], '3');
    assert.equal(response.headers['RateLimit-Remaining'], '2');
  });

  test('a caller over the window gets 429 and a Retry-After', () => {
    const limiter = middleware(2);
    let passed = 0;
    const next = (): void => {
      passed += 1;
    };

    for (let i = 0; i < 2; i += 1) {
      limiter.use({ ip: '10.0.0.2' } as never, fakeResponse() as never, next);
    }

    const blocked = fakeResponse();
    limiter.use({ ip: '10.0.0.2' } as never, blocked as never, next);

    assert.equal(passed, 2);
    assert.equal(blocked.code, 429);
    assert.equal(blocked.headers['Retry-After'], '60');
    assert.equal(blocked.headers['RateLimit-Remaining'], '0');
  });

  test('one noisy caller does not spend another caller’s budget', () => {
    const limiter = middleware(1);
    const first = fakeResponse();
    const second = fakeResponse();

    limiter.use({ ip: '10.0.0.3' } as never, first as never, () => {});
    limiter.use({ ip: '10.0.0.3' } as never, fakeResponse() as never, () => {});
    limiter.use({ ip: '10.0.0.4' } as never, second as never, () => {});

    assert.equal(first.code, null);
    assert.equal(second.code, null);
  });
});

describe('the cheapest limit is not serving the request', () => {
  test('a repeat read is served from memory and carries an ETag', async () => {
    // A query string no earlier test used, so the entry is genuinely cold.
    const url = `${base}/v1/registry/conversions/${ASSUMED}?cold=1`;
    const first = await fetch(url);
    const etag = first.headers.get('etag');

    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-cache'), 'miss');
    assert.ok(etag !== null && etag.length > 2, 'no ETag on a cacheable response');

    const second = await fetch(url);

    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-cache'), 'hit');
    assert.equal(second.headers.get('etag'), etag);
    assert.match(second.headers.get('cache-control') ?? '', /public/u);
    assert.deepEqual(await second.json(), await first.json());
  });

  test('a client that already holds the answer gets 304 and no body', async () => {
    const first = await fetch(`${base}/v1/registry/observation-types`);
    const etag = first.headers.get('etag')!;

    const revalidated = await fetch(`${base}/v1/registry/observation-types`, {
      headers: { 'if-none-match': etag },
    });

    assert.equal(revalidated.status, 304);
    assert.equal(await revalidated.text(), '');
  });

  test('a stale validator is answered in full, not with 304', async () => {
    await fetch(`${base}/v1/registry/crop-codes`);

    const response = await fetch(`${base}/v1/registry/crop-codes`, {
      headers: { 'if-none-match': '"something-else-entirely"' },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { crop_codes: unknown[] };
    assert.ok(Array.isArray(body.crop_codes));
  });

  test('different query strings are different cache entries', async () => {
    const one = await fetch(`${base}/v1/registry/admin-regions?level=district`);
    const other = await fetch(`${base}/v1/registry/admin-regions?level=country`);

    const districts = ((await one.json()) as { admin_regions: unknown[] }).admin_regions;
    const countries = ((await other.json()) as { admin_regions: unknown[] }).admin_regions;

    assert.ok(districts.length > countries.length);
    assert.notDeepEqual(districts, countries);
  });

  test('a 404 is not cached — a migration can turn it into a 200', async () => {
    const missing = `${base}/v1/registry/crop-codes/crop.nothing.here`;
    const first = await fetch(missing);
    const second = await fetch(missing);

    assert.equal(first.status, 404);
    assert.equal(second.status, 404);
    assert.equal(second.headers.get('x-cache'), null);
  });

  test('a caller with a subject header is never answered from the cache', async () => {
    // The guard that matters. Every other route in the kernel is
    // consent-dependent, so a URL-keyed cache that ignored identity would
    // hand one subject's records to another. Registry routes do not vary by
    // caller, but the interceptor must not be the thing relied on to know
    // that.
    const response = await fetch(`${base}/v1/registry/conversions/${MEASURED}`, {
      headers: { [SUBJECT_HEADER]: '019fc600-0000-7000-8000-0000000000ff' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), null);
  });

  test('a cached hit still spends rate-limit budget', async () => {
    // A limiter that only counts expensive requests can be defeated by making
    // cheap ones. The middleware runs before the interceptor, so the headers
    // must keep moving on a hit.
    await fetch(`${base}/v1/registry/grading-schemes`);
    const first = await fetch(`${base}/v1/registry/grading-schemes`);
    const second = await fetch(`${base}/v1/registry/grading-schemes`);

    assert.equal(second.headers.get('x-cache'), 'hit');
    assert.ok(
      Number(second.headers.get('ratelimit-remaining')) <
        Number(first.headers.get('ratelimit-remaining')),
    );
  });
});
