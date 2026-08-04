import { before, after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import {
  startTestDatabase,
  sqlState,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from '../helpers/database.js';
import {
  auditServiceFor,
  consentServiceFor,
  objectionServiceFor,
  entityDocument,
  ingestServiceFor,
  readingAs,
} from '../helpers/fixtures.js';
import { InferenceRepository } from '../../src/inference/inference.repository.js';
import { ReadService } from '../../src/records/read.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { AnchorRepository } from '../../src/anchoring/anchor.repository.js';
import { AnchorService } from '../../src/anchoring/anchor.service.js';
import {
  canonical,
  leafHash,
  merkleRoot,
  newSalt,
  nodeHash,
  proofFor,
  recordDigest,
  rootFromProof,
} from '../../src/anchoring/merkle.js';
import {
  encodeMessage,
  type PublishReceipt,
  type TopicPublisher,
} from '../../src/anchoring/publisher.js';

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

let db: TestDatabase;
let anchors: AnchorRepository;
let service: AnchorService;
let read: ReadService;
let ingest: ReturnType<typeof ingestServiceFor>['ingest']['ingest'];
let publisher: FakePublisher;

/* ── a publisher that never touches a network ─────────────────────────────── */

/**
 * The ledger is not the thing under test; what the kernel does around it is.
 * This fake records every message and can be told to fail, which is the only
 * behaviour of a real network that the retry path cares about.
 */
class FakePublisher implements TopicPublisher {
  readonly network = 'testnet' as const;
  readonly sent: string[] = [];
  failWith: string | null = null;
  private sequence = 0;

  publish(message: string): Promise<PublishReceipt> {
    if (this.failWith !== null) {
      return Promise.reject(new Error(this.failWith));
    }
    this.sent.push(message);
    this.sequence += 1;
    return Promise.resolve({
      topicId: '0.0.4242',
      sequenceNumber: String(this.sequence),
      consensusAt: new Date(),
      transactionId: `0.0.99@${this.sequence}`,
    });
  }
}

/** Today, as the batch dates are written. */
const today = (): string => new Date().toISOString().slice(0, 10);

before(async () => {
  db = await startTestDatabase();
  anchors = new AnchorRepository(db.app);
  publisher = new FakePublisher();

  read = new ReadService(
    new RecordRepository(db.app),
    consentServiceFor(db.app),
    objectionServiceFor(db.app),
    auditServiceFor(db.app),
    new InferenceRepository(db.app),
  );
  service = new AnchorService(anchors, read, auditServiceFor(db.app), publisher);
  ingest = ingestServiceFor(db.app).ingest.ingest;
});

after(async () => {
  await db.stop();
});

/* ── the tree ─────────────────────────────────────────────────────────────── */

describe('the tree', () => {
  const leaves = (count: number): string[] =>
    Array.from({ length: count }, (_unused, index) =>
      leafHash(newSalt(), recordDigest({ n: index })),
    );

  test('a root is stable for the same leaves in the same order', () => {
    const set = leaves(7);
    assert.equal(merkleRoot(set), merkleRoot([...set]));
  });

  test('order matters — a reordered set is a different tree', () => {
    const set = leaves(6);
    const swapped = [...set];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    assert.notEqual(merkleRoot(set), merkleRoot(swapped));
  });

  test('a single leaf is its own root', () => {
    const one = leaves(1);
    assert.equal(merkleRoot(one), one[0]);
  });

  /**
   * CVE-2012-2459. Duplicating the odd node makes a tree of [a, b, c] and a
   * tree of [a, b, c, c] produce the same root, which means a root proves
   * membership of a set you cannot recover. Promotion does not.
   */
  test('an odd node is promoted, not duplicated', () => {
    const three = leaves(3);
    const duplicated = [...three, three[2]!];
    assert.notEqual(
      merkleRoot(three),
      merkleRoot(duplicated),
      'promoting and duplicating must not agree, or the root is ambiguous',
    );
  });

  /**
   * Without domain separation an internal node is a valid leaf, so a proof for
   * a subtree hash can be passed off as a proof for a record nobody wrote.
   */
  test('a leaf cannot be passed off as an internal node', () => {
    const [left, right] = [leaves(1)[0]!, leaves(1)[0]!];
    const salt = newSalt();
    const asNode = nodeHash(left, right);
    const asLeaf = leafHash(salt, left + right);
    assert.notEqual(asNode, asLeaf);
  });

  test('a leaf hash changes when the salt changes and the record does not', () => {
    const digest = recordDigest({ weight_kg: 84, farmer: 'the same person' });
    assert.notEqual(leafHash(newSalt(), digest), leafHash(newSalt(), digest));
  });

  test('a proof round-trips at every index, for every size from one to nine', () => {
    for (let size = 1; size <= 9; size += 1) {
      const set = leaves(size);
      const root = merkleRoot(set);
      for (let index = 0; index < size; index += 1) {
        const path = proofFor(set, index);
        assert.equal(
          rootFromProof(set[index]!, path),
          root,
          `size ${size}, index ${index}`,
        );
      }
    }
  });

  test('a tampered leaf does not reach the root', () => {
    const set = leaves(5);
    const root = merkleRoot(set);
    const path = proofFor(set, 2);
    assert.notEqual(rootFromProof(leaves(1)[0]!, path), root);
  });

  test('canonical form does not depend on key order', () => {
    assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
    assert.notEqual(canonical({ a: 1, b: 2 }), canonical({ a: 1, b: 3 }));
  });
});

/* ── the guard ────────────────────────────────────────────────────────────── */

/**
 * The one failure in this system that cannot be undone. A root over fabricated
 * farmer records, once on a public ledger, is there for good and looks exactly
 * like a root over real ones. So the guard is stated three times, and each
 * statement is checked here on its own.
 */
describe('only live data is ever anchored', () => {
  test('a batch row for a seed dataset is refused by the database', async () => {
    await assert.rejects(
      db.owner.query(
        `insert into kernel.anchor_batch
           (id, dataset, batch_date, record_count, merkle_root, network)
         values ($1, 'seed', current_date, 1, repeat('a', 64), 'testnet')`,
        [uuidv7()],
      ),
      (error: unknown) => sqlState(error) === CHECK_VIOLATION,
    );
  });

  test('a leaf for a seed record is refused, whatever the batch says', async () => {
    const seedRecord = await ingest(entityDocument('party', {}), { dataset: 'seed' });

    const batchId = uuidv7();
    await db.owner.query(
      `insert into kernel.anchor_batch
         (id, dataset, batch_date, record_count, merkle_root, network)
       values ($1, 'live', date '2001-01-01', 1, repeat('b', 64), 'testnet')`,
      [batchId],
    );

    await assert.rejects(
      db.owner.query(
        `insert into kernel.anchor_leaf
           (batch_id, record_id, position, salt, record_digest, leaf_hash)
         values ($1, $2, 0, repeat('c', 64), repeat('d', 64), repeat('e', 64))`,
        [batchId, seedRecord.record.id],
      ),
      (error: unknown) => sqlState(error) === CHECK_VIOLATION,
    );
  });

  test('a leaf for a record that does not exist at all is refused', async () => {
    const batchId = uuidv7();
    await db.owner.query(
      `insert into kernel.anchor_batch
         (id, dataset, batch_date, record_count, merkle_root, network)
       values ($1, 'live', date '2001-01-02', 1, repeat('b', 64), 'testnet')`,
      [batchId],
    );

    await assert.rejects(
      db.owner.query(
        `insert into kernel.anchor_leaf
           (batch_id, record_id, position, salt, record_digest, leaf_hash)
         values ($1, $2, 0, repeat('c', 64), repeat('d', 64), repeat('e', 64))`,
        [batchId, uuidv7()],
      ),
      (error: unknown) => sqlState(error) === FOREIGN_KEY_VIOLATION,
    );
  });

  test('the selection never offers a seed record in the first place', async () => {
    await ingest(entityDocument('party', {}), { dataset: 'seed' });
    const offered = await anchors.unanchored(today(), 5_000);
    assert.ok(
      offered.length >= 0,
      'the view is the filter; what matters is what is absent from it',
    );

    const { rows } = await db.app.query<{ count: string }>(
      `select count(*)::text as count
         from kernel.unanchored_record u
         join kernel.record_key k on k.id = u.id
        where k.dataset <> 'live'`,
    );
    assert.equal(rows[0]?.count, '0');
  });
});

/* ── a day's run ──────────────────────────────────────────────────────────── */

describe('a day is anchored once', () => {
  test('a run batches the day and publishes one message', async () => {
    await ingest(entityDocument('party', {}));
    await ingest(entityDocument('party', {}));

    const sentBefore = publisher.sent.length;
    const run = await service.run(today());

    assert.ok(run.batch !== null);
    assert.equal(run.batch.state, 'published');
    assert.equal(run.published, true);
    assert.equal(run.error, null);
    assert.ok(run.batch.record_count > 0);
    assert.equal(publisher.sent.length, sentBefore + 1, 'one message, not one per record');
  });

  test('the message carries the root and nothing about any record', async () => {
    const message = publisher.sent.at(-1);
    assert.ok(message !== undefined);

    const decoded: unknown = JSON.parse(message);
    const body = decoded as Record<string, unknown>;
    assert.equal(body['kind'], 'clycites.anchor');
    assert.equal(body['dataset'], 'live');
    assert.equal(body['alg'], 'sha256/salted-leaf/v1');
    assert.match(String(body['root']), /^[0-9a-f]{64}$/u);
    assert.deepEqual(Object.keys(body).sort(), [
      'alg',
      'count',
      'dataset',
      'date',
      'kind',
      'root',
      'v',
    ]);
  });

  test('re-running the same day is a no-op — one batch, one root', async () => {
    const first = await anchors.batchFor(today());
    assert.ok(first !== null);

    const sentBefore = publisher.sent.length;
    const again = await service.run(today());

    assert.equal(again.batch?.id, first.id);
    assert.equal(again.batch?.merkle_root, first.merkle_root);
    assert.equal(again.anchored, 0);
    assert.equal(publisher.sent.length, sentBefore, 'nothing was published twice');
  });

  test('a record is anchored exactly once, ever', async () => {
    const { rows } = await db.app.query<{ count: string }>(
      `select count(*)::text as count from (
         select record_id from kernel.anchor_leaf
          group by record_id having count(*) > 1
       ) repeated`,
    );
    assert.equal(rows[0]?.count, '0');
  });

  test('a record written after the batch is picked up by the next run', async () => {
    const late = await ingest(entityDocument('party', {}));

    // Tomorrow, because today already has a batch and a day gets one.
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const run = await service.run(tomorrow.toISOString().slice(0, 10));

    assert.ok(run.batch !== null);
    const leaf = await anchors.leafFor(late.record.id);
    assert.ok(leaf !== null, 'the late record was not dropped');
    assert.equal(leaf.batch_id, run.batch.id);
  });

  test('a day with nothing in it produces no batch and no message', async () => {
    const sentBefore = publisher.sent.length;
    const run = await service.run('2001-06-01');

    assert.equal(run.batch, null);
    assert.equal(publisher.sent.length, sentBefore, 'an empty root says nothing and costs a fee');
  });
});

/* ── failure ──────────────────────────────────────────────────────────────── */

describe('a network failure delays a batch, never drops records', () => {
  /**
   * A day of its own. Days are anchored once, so a test that needs a fresh
   * batch needs a date no other test has taken.
   */
  const dayAhead = (days: number): string => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };

  let failedDay: string;
  let failedRoot: string;

  test('a failed publish keeps the batch and records why', async () => {
    await ingest(entityDocument('party', {}));

    failedDay = dayAhead(5);
    publisher.failWith = 'the topic is unreachable';
    const run = await service.run(failedDay);
    publisher.failWith = null;

    assert.ok(run.batch !== null, 'the records were batched even though the network was not there');
    assert.equal(run.published, false);
    assert.equal(run.error, 'the topic is unreachable');

    const stored = await anchors.batchById(run.batch.id);
    assert.equal(stored?.state, 'failed');
    assert.equal(stored?.attempts, 1);
    assert.equal(stored?.last_error, 'the topic is unreachable');
    assert.match(stored?.merkle_root ?? '', /^[0-9a-f]{64}$/u, 'the tree survived the failure');

    failedRoot = run.batch.merkle_root;
  });

  test('the records are in the tree, not waiting to be re-selected', async () => {
    const stillOffered = await anchors.unanchored(failedDay, 5_000);
    assert.equal(stillOffered.length, 0, 'nothing was dropped and nothing is duplicated');
  });

  test('a later run retries the failed batch and publishes the same root', async () => {
    const run = await service.run(failedDay);

    assert.equal(run.error, null);
    assert.equal(run.batch?.state, 'published');
    assert.equal(run.batch?.merkle_root, failedRoot, 'the same root, republished');
  });

  test('backoff grows and then holds', () => {
    assert.ok(service.backoffFor(0) < service.backoffFor(1));
    assert.ok(service.backoffFor(1) < service.backoffFor(2));
    assert.equal(service.backoffFor(99), service.backoffFor(4));
  });

  test('a kernel with no publisher batches anyway and says why', async () => {
    const offline = new AnchorService(anchors, read, auditServiceFor(db.app), null);
    assert.equal(offline.configured, false);

    await ingest(entityDocument('party', {}));
    const run = await offline.run(dayAhead(6));

    assert.ok(run.batch !== null, 'the root exists locally; only the publish is missing');
    assert.equal(run.error, 'no publisher is configured');
    assert.equal(run.batch.state, 'pending', 'nothing was attempted, so nothing failed');
  });
});

/* ── what a published batch is ────────────────────────────────────────────── */

describe('a published root cannot be quietly revised', () => {
  test('a published batch refuses to change', async () => {
    const published = (await anchors.publishedRoots())[0];
    assert.ok(published !== undefined);

    await assert.rejects(
      db.owner.query(
        `update kernel.anchor_batch set merkle_root = repeat('f', 64)
          where merkle_root = $1`,
        [published.merkle_root],
      ),
      (error: unknown) => sqlState(error) === INSUFFICIENT_PRIVILEGE,
    );
  });

  test('a published batch refuses to be deleted', async () => {
    await assert.rejects(
      db.owner.query(`delete from kernel.anchor_batch`),
      (error: unknown) => sqlState(error) === INSUFFICIENT_PRIVILEGE,
    );
  });

  test('a leaf is append-only', async () => {
    await assert.rejects(
      db.owner.query(`update kernel.anchor_leaf set salt = repeat('0', 64)`),
      (error: unknown) => sqlState(error) === INSUFFICIENT_PRIVILEGE,
    );
  });
});

/* ── proof ────────────────────────────────────────────────────────────────── */

describe('a third party can check one record and see no other', () => {
  let subject: string;
  let recordId: string;

  before(async () => {
    subject = uuidv7();
    await ingest(entityDocument('party', { id: subject, asserted_by: subject }));
    const written = await ingest(
      entityDocument('observation', {
        asserted_by: subject,
        subject_type: 'party',
        subject_ref: subject,
      }),
    );
    recordId = written.record.id;

    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 2);
    await service.run(tomorrow.toISOString().slice(0, 10));
  });

  test('the proof reproduces the published root', async () => {
    const proof = await service.proof(recordId, readingAs(subject));
    assert.ok(proof !== null);
    assert.equal(rootFromProof(proof.leaf_hash, proof.path), proof.merkle_root);
  });

  test('the leaf is the salt and the record, and can be recomputed', async () => {
    const proof = await service.proof(recordId, readingAs(subject));
    assert.ok(proof !== null);
    assert.equal(leafHash(proof.salt, proof.record_digest), proof.leaf_hash);
    assert.match(proof.salt, /^[0-9a-f]{64}$/u);
  });

  /** The property the whole scheme exists for. */
  test('the proof discloses no other record in the batch', async () => {
    const proof = await service.proof(recordId, readingAs(subject));
    assert.ok(proof !== null);

    const leaf = await anchors.leafFor(recordId);
    assert.ok(leaf !== null);
    const all = await anchors.leaves(leaf.batch_id);
    assert.ok(all.length > 1, 'a batch of one would make this test vacuous');
    const serialised = JSON.stringify(proof);
    for (const other of all) {
      if (other.record_id === recordId) continue;
      assert.ok(!serialised.includes(other.record_id), 'no other record id appears');
      assert.ok(!serialised.includes(other.salt), 'no other salt appears');
      assert.ok(!serialised.includes(other.record_digest), 'no other digest appears');
    }

    // Every step is a bare hash and a side. Nothing else is in there to leak.
    for (const step of proof.path) {
      assert.deepEqual(Object.keys(step).sort(), ['hash', 'side']);
      assert.match(step.hash, /^[0-9a-f]{64}$/u);
    }
  });

  /**
   * The salt is the defence, and the proof carries it. Handing proofs out
   * freely would undo the reason salts exist.
   */
  test('a caller who may not read the record gets no proof', async () => {
    const proof = await service.proof(recordId, readingAs(uuidv7()));
    assert.equal(proof, null);
  });

  test('an unanchored record has no proof, and looks the same as no record', async () => {
    const fresh = await ingest(
      entityDocument('observation', {
        asserted_by: subject,
        subject_type: 'party',
        subject_ref: subject,
      }),
    );
    assert.equal(await service.proof(fresh.record.id, readingAs(subject)), null);
    assert.equal(await service.proof(uuidv7(), readingAs(subject)), null);
  });

  test('the roots are public and carry nothing but roots', async () => {
    const roots = await service.roots();
    assert.ok(roots.length > 0);
    for (const root of roots) {
      assert.match(root.merkle_root, /^[0-9a-f]{64}$/u);
      assert.ok(root.record_count > 0);
    }
  });
});

/* ── the training role ────────────────────────────────────────────────────── */

describe('the training role sees none of it', () => {
  for (const relation of [
    'kernel.anchor_batch',
    'kernel.anchor_leaf',
    'kernel.unanchored_record',
    'kernel.published_root',
  ]) {
    test(`${relation} is closed to kernel_training`, async () => {
      await assert.rejects(
        db.training.query(`select * from ${relation} limit 1`),
        (error: unknown) => sqlState(error) === INSUFFICIENT_PRIVILEGE,
        relation,
      );
    });
  }
});

/* ── the message ──────────────────────────────────────────────────────────── */

describe('the message is small on purpose', () => {
  test('a root over a hundred thousand records is the same size as one over two', () => {
    const small = encodeMessage({
      v: 1,
      kind: 'clycites.anchor',
      dataset: 'live',
      date: '2026-08-03',
      root: 'a'.repeat(64),
      count: 2,
      alg: 'sha256/salted-leaf/v1',
    });
    const large = encodeMessage({
      v: 1,
      kind: 'clycites.anchor',
      dataset: 'live',
      date: '2026-08-03',
      root: 'a'.repeat(64),
      count: 100_000,
      alg: 'sha256/salted-leaf/v1',
    });
    assert.ok(large.length - small.length < 10, 'the cost does not grow with the batch');
    assert.ok(large.length < 200, 'HCS charges by the byte');
  });
});
