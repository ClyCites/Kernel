import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from '@clycites/schema';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  auditServiceFor,
  deliveryDocument,
  ingestServiceFor,
  type TestIngest,
  readingAs,
  consentServiceFor,
  objectionServiceFor,
} from '../helpers/fixtures.js';
import { ReadService } from '../../src/records/read.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { QueryRejected } from '../../src/records/errors.js';

let db: TestDatabase;
let ingest: TestIngest;
let repository: RecordRepository;
let read: ReadService;

before(async () => {
  db = await startTestDatabase();
  ({ ingest, repository } = ingestServiceFor(db.app));
  read = new ReadService(repository, consentServiceFor(db.app), objectionServiceFor(db.app), auditServiceFor(db.app));
});

after(async () => {
  await db.stop();
});

/** A delivery and `count` successive corrections of it, oldest first. */
async function chainOf(count: number, asserter = uuidv7()): Promise<string[]> {
  const first = await ingest.ingest(
    deliveryDocument({ asserted_by: asserter, to_party: asserter }),
  );
  const ids = [first.record.id];

  for (let i = 0; i < count; i += 1) {
    const next = await ingest.ingest(
      deliveryDocument({
        asserted_by: asserter,
        to_party: asserter,
        supersedes: ids.at(-1),
        quantity: {
          raw_value: 12 + i,
          raw_unit: 'bag',
          measurement_method: 'coop_weighed',
        },
      }),
    );
    ids.push(next.record.id);
  }

  return ids;
}

function retractionOf(target: string, asserter: string): Record<string, unknown> {
  return {
    id: uuidv7(),
    type: 'retraction',
    record_class: 'observation',
    schema_version: SCHEMA_VERSION,
    occurred_at: '2026-07-20T09:00:00+03:00',
    occurred_at_precision: 'day',
    asserted_by: asserter,
    target,
    reason_code: 'test_entry',
  };
}

/* ── supersession ─────────────────────────────────────────────────────── */

describe('supersession resolves to the tip of the chain (brief §5.3)', () => {
  test('a superseded record is absent from a default read', async () => {
    const asserter = uuidv7();
    const [original, correction] = await chainOf(1, asserter);

    const page = await read.list(
      { type: 'delivery', assertedBy: asserter },
      readingAs(asserter),
    );
    const ids = page.records.map((view) => view.record['id']);

    assert.deepEqual(ids, [correction]);
    assert.ok(!ids.includes(original));
  });

  test('a superseded record is still retrievable by explicit id', async () => {
    const asserter = uuidv7();
    const [original, correction] = await chainOf(1, asserter);

    const view = await read.get(original!, readingAs(asserter));

    assert.ok(view);
    assert.equal(view.record['id'], original);
    assert.deepEqual(view.superseded_by, [correction]);
    assert.equal(view.record['superseded_by'], correction);
  });

  test('the full chain is walkable from any point in it', async () => {
    const asserter = uuidv7();
    const ids = await chainOf(3, asserter);

    for (const start of ids) {
      const chain = await read.chain(start, readingAs(asserter));
      assert.deepEqual(
        chain.map((view) => view.record['id']),
        ids,
        `walking from ${start} must give the whole chain`,
      );
    }
  });

  test('only the tip of a long chain survives a default read', async () => {
    const asserter = uuidv7();
    const ids = await chainOf(4, asserter);

    const page = await read.list(
      { type: 'delivery', assertedBy: asserter },
      readingAs(asserter),
    );

    assert.deepEqual(
      page.records.map((view) => view.record['id']),
      [ids.at(-1)],
    );
    assert.equal(page.records[0]?.record['superseded_by'], null);
  });

  test('a fork is surfaced rather than resolved', async () => {
    const asserter = uuidv7();
    const [original] = await chainOf(0, asserter);

    const left = await ingest.ingest(
      deliveryDocument({
        asserted_by: asserter,
        to_party: asserter,
        supersedes: original,
      }),
    );
    const right = await ingest.ingest(
      deliveryDocument({
        asserted_by: asserter,
        to_party: asserter,
        supersedes: original,
      }),
    );

    const view = await read.get(original!, readingAs(asserter));
    assert.equal(view?.superseded_by.length, 2);
    assert.deepEqual(view?.superseded_by.slice().sort(), [left.record.id, right.record.id].sort());

    const page = await read.list(
      { type: 'delivery', assertedBy: asserter },
      readingAs(asserter),
    );
    assert.equal(page.records.length, 2, 'both branches are current');
  });
});

/* ── retraction ───────────────────────────────────────────────────────── */

describe('retracted records are excluded from default reads (spec §8.1)', () => {
  test('a retracted delivery disappears from a list but stays in the log', async () => {
    const asserter = uuidv7();
    const [delivery] = await chainOf(0, asserter);

    await ingest.ingest(retractionOf(delivery!, asserter));

    const page = await read.list(
      { type: 'delivery', assertedBy: asserter },
      readingAs(asserter),
    );
    assert.deepEqual(page.records, []);

    const view = await read.get(delivery!, readingAs(asserter));
    assert.ok(view, 'the record is retained, not deleted');
    assert.equal(view.retracted, true);
  });

  test('a retraction of a record that is not in the log is refused', async () => {
    const error = await ingest
      .ingest(retractionOf(uuidv7(), uuidv7()))
      .then(() => null, (e: unknown) => e);

    assert.ok(error instanceof Error);
    assert.match(error.message, /not in the log/);
  });

  test('only the party who made the claim may retract it', async () => {
    const [delivery] = await chainOf(0);

    const error = await ingest
      .ingest(retractionOf(delivery!, uuidv7()))
      .then(() => null, (e: unknown) => e);

    assert.ok(error instanceof Error);
    assert.match(error.message, /may retract their own record/);
  });

  test('a retracted record is marked as such everywhere in its chain', async () => {
    const asserter = uuidv7();
    const ids = await chainOf(2, asserter);
    await ingest.ingest(retractionOf(ids[1]!, asserter));

    const chain = await read.chain(ids[0]!, readingAs(asserter));

    assert.deepEqual(
      chain.map((view) => view.retracted),
      [false, true, false],
    );
  });
});

/* ── listing ──────────────────────────────────────────────────────────── */

describe('listing (brief §5.3)', () => {
  test('by asserted_by returns only that party’s claims', async () => {
    const mine = uuidv7();
    const theirs = uuidv7();
    await ingest.ingest(deliveryDocument({ asserted_by: mine }));
    await ingest.ingest(deliveryDocument({ asserted_by: theirs }));

    const page = await read.list({ assertedBy: mine }, readingAs(mine));

    assert.equal(page.records.length, 1);
    assert.equal(page.records[0]?.record['asserted_by'], mine);
  });

  test('by subject matches either side of a delivery', async () => {
    const farmer = uuidv7();
    const coop = uuidv7();
    const buyer = uuidv7();

    await ingest.ingest(
      deliveryDocument({ asserted_by: coop, from_party: farmer, to_party: coop }),
    );
    await ingest.ingest(
      deliveryDocument({ asserted_by: coop, from_party: coop, to_party: buyer }),
    );

    const farmerPage = await read.list(
      { type: 'delivery', subject: farmer },
      readingAs(coop),
    );
    const coopPage = await read.list(
      { type: 'delivery', subject: coop },
      readingAs(coop),
    );

    assert.equal(farmerPage.records.length, 1);
    assert.equal(coopPage.records.length, 2, 'the coop received one and sent one');
  });

  test('an unknown type is refused rather than returning nothing', async () => {
    await assert.rejects(
      () => read.list({ type: 'shipment' }, readingAs(uuidv7())),
      (error: unknown) =>
        error instanceof QueryRejected && error.code === 'unknown_record_type',
    );
  });

  test('paging walks every record exactly once', async () => {
    const asserter = uuidv7();
    for (let i = 0; i < 7; i += 1) {
      await ingest.ingest(deliveryDocument({ asserted_by: asserter }));
    }

    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page: { records: Array<{ record: Record<string, unknown> }>; next_cursor: string | null } =
        await read.list(
          { assertedBy: asserter, limit: 3, cursor: cursor ?? undefined },
          readingAs(asserter),
        );
      seen.push(...page.records.map((view) => view.record['id']));
      cursor = page.next_cursor;
    } while (cursor !== null);

    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
  });

  test('a cursor we did not issue is refused', async () => {
    await assert.rejects(
      () => read.list({ cursor: 'not-a-cursor' }, readingAs(uuidv7())),
      (error: unknown) =>
        error instanceof QueryRejected && error.code === 'invalid_cursor',
    );
  });
});

/* ── namespace separation ─────────────────────────────────────────────── */

describe('inference is not readable through the default path (brief §4.2)', () => {
  /** An inferred observation about a party, so it has a subject to govern. */
  async function inferenceAbout(party: string): Promise<string> {
    const id = uuidv7();
    await db.owner.query(
      `insert into inference.record (
         id, type, record_class, schema_version, occurred_at, occurred_at_precision,
         recorded_at, asserted_by, body, lawful_basis
       ) values ($1, 'observation', 'inference', $2, now(), 'day', now(), $3, $4::jsonb,
                 'consent')`,
      [id, SCHEMA_VERSION, party, JSON.stringify({ subject_ref: party })],
    );
    return id;
  }

  test('an inference is invisible to get, list and chain', async () => {
    const party = uuidv7();
    const id = await inferenceAbout(party);
    await ingest.ingest(deliveryDocument({ asserted_by: party }));

    assert.equal(await read.get(id, readingAs(party)), null);
    assert.deepEqual(await read.chain(id, readingAs(party)), []);

    const page = await read.list({ assertedBy: party }, readingAs(party));
    assert.ok(!page.records.some((view) => view.record['id'] === id));
  });

  test('an inference is reachable only by asking for it by name', async () => {
    const party = uuidv7();
    const id = await inferenceAbout(party);

    const view = await read.getInference(id, readingAs(party));

    assert.equal(view?.record['id'], id);
    assert.equal(view?.record['record_class'], 'inference');
  });
});
