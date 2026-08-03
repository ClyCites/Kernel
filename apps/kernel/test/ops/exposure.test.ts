import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { loadConfig } from '../../src/config.js';

/**
 * Configuration guards.
 *
 * Most self-hosted incidents are configuration mistakes, not attackers, and a
 * published database port or a copied `.env` is invisible to every functional
 * test in this repository — the kernel behaves identically either way. These
 * assertions are the only thing that notices.
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');

const COMPOSE = read('/docker-compose.yml');
const ENV_EXAMPLE = read('/.env.example');

/** Services that must never be reachable from outside the private network. */
const DATA_TIER = ['postgres', 'minio', 'redis', 'valkey'];

/**
 * The compose file is parsed by indentation rather than with a YAML library.
 * It is our own file, twenty lines long, and adding a dependency to read it
 * would put the guard behind a supply chain it is partly there to protect.
 */
function servicePorts(compose: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let service: string | null = null;
  let inPorts = false;

  for (const raw of compose.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;

    const top = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (top) {
      service = top[1]!;
      found.set(service, []);
      inPorts = false;
      continue;
    }
    if (/^\S/.test(line)) {
      service = null;
      inPorts = false;
      continue;
    }
    if (service === null) continue;

    if (/^ {4}ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      inPorts = false;
      continue;
    }
    const entry = /^ {6}-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (inPorts && entry) found.get(service)!.push(entry[1]!);
  }
  return found;
}

describe('the data tier is not published', () => {
  const ports = servicePorts(COMPOSE);

  test('the compose file parses into services', () => {
    assert.ok(ports.has('postgres'), `services found: ${[...ports.keys()]}`);
  });

  test('no data-tier service publishes beyond loopback', () => {
    for (const service of DATA_TIER) {
      for (const published of ports.get(service) ?? []) {
        assert.match(
          published,
          /^127\.0\.0\.1:/,
          `${service} publishes "${published}". A port without an explicit ` +
            'loopback address is published on every interface the host has, ' +
            'which on most VPS images is the open internet. Tunnel instead.',
        );
      }
    }
  });

  test('nothing binds 0.0.0.0 explicitly', () => {
    assert.doesNotMatch(
      COMPOSE,
      /0\.0\.0\.0/,
      'an explicit 0.0.0.0 bind publishes on every interface the host has',
    );
  });
});

describe('the example environment is complete and safe to copy', () => {
  const declared = new Set(
    ENV_EXAMPLE.split('\n')
      .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
      .filter((name): name is string => name !== undefined),
  );

  /** Everything loadConfig will refuse to start without. */
  const REQUIRED = [
    'DATABASE_URL',
    'MIGRATOR_DATABASE_URL',
    'KERNEL_APP_PASSWORD',
  ];

  test('every required variable is present', () => {
    for (const name of REQUIRED) {
      assert.ok(declared.has(name), `.env.example is missing ${name}`);
    }
  });

  test('every variable the example declares is one the kernel reads', () => {
    const source = read('/apps/kernel/src/config.ts');
    for (const name of declared) {
      assert.match(
        source,
        new RegExp(`\\b${name}\\b`),
        `.env.example declares ${name}, which no longer exists in config.ts`,
      );
    }
  });

  test('the example does not ship seed ingest turned on', () => {
    assert.doesNotMatch(
      ENV_EXAMPLE,
      /^SEED_INGEST_ENABLED\s*=\s*true/m,
      'a copied .env would let fabricated records into an append-only log',
    );
  });

  test('the example carries no real-looking secret', () => {
    // Placeholders have to be obviously placeholders. `dev_only` is the
    // convention; anything else in a password position is a leaked credential
    // until proven otherwise.
    const passwords = [...ENV_EXAMPLE.matchAll(/^([A-Z_]*PASSWORD)=(.*)$/gm)];
    assert.ok(passwords.length > 0, 'expected at least one password example');
    for (const [, name, value] of passwords) {
      assert.match(
        String(value),
        /dev_only|changeme|<|placeholder/,
        `${name} does not look like a placeholder`,
      );
    }
  });
});

describe('a production instance refuses to seed', () => {
  const base = {
    DATABASE_URL: 'postgres://x/y',
    MIGRATOR_DATABASE_URL: 'postgres://x/y',
    KERNEL_APP_PASSWORD: 'x',
  };

  test('seed ingest in production is a refusal to start, not a warning', () => {
    assert.throws(
      () =>
        loadConfig({
          ...base,
          NODE_ENV: 'production',
          SEED_INGEST_ENABLED: 'true',
        }),
      /refusing to start/,
    );
  });

  test('the same configuration is allowed outside production', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'staging',
      SEED_INGEST_ENABLED: 'true',
    });
    assert.equal(config.SEED_INGEST_ENABLED, true);
  });

  test('production without seeding starts', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'production' });
    assert.equal(config.SEED_INGEST_ENABLED, false);
  });
});

/*
 * We owe no s.16(4) disclosure-notification machinery today because there is no
 * export path: with view-only access, revoking access is sufficient, but an
 * export makes the recipient an independent holder and we owe them a
 * notification for every future correction, indefinitely. "Never add an export"
 * decays as a memory. It holds as a failing build.
 */
describe('there is no bulk export', () => {
  const API = fileURLToPath(new URL('../../src/api', import.meta.url));

  test('no route resembles an export', async () => {
    const files = (await readdir(API)).filter((f) => f.endsWith('.ts'));
    const offending: string[] = [];

    for (const file of files) {
      const source = readFileSync(`${API}/${file}`, 'utf8');
      for (const match of source.matchAll(
        /@(?:Get|Post|Put|Patch|Delete)\(\s*'([^']*)'/g,
      )) {
        const route = match[1] ?? '';
        if (/export|download|dump|bulk|extract|report/i.test(route)) {
          offending.push(`${file}: ${route}`);
        }
      }
    }

    assert.deepEqual(
      offending,
      [],
      'a route that hands out a copy of the record makes its recipient an ' +
        'independent holder, and DPPA s.16(4) then owes them a notification ' +
        'on every later correction. Read docs/decisions/0020 before removing ' +
        'this test.',
    );
  });

  test('no controller streams a file back', () => {
    for (const controller of ['records', 'sync', 'operations']) {
      const source = read(`/apps/kernel/src/api/${controller}.controller.ts`);
      assert.doesNotMatch(
        source,
        /content-disposition|createReadStream|StreamableFile/i,
        `${controller}.controller.ts looks like it serves a file`,
      );
    }
  });
});
