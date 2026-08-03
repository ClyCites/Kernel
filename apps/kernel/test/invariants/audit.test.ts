import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { uuidv7 } from 'uuidv7';

import {
  INSUFFICIENT_PRIVILEGE,
  RESTRICT_VIOLATION,
  sqlState,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import {
  auditServiceFor,
  deliveryDocument,
  ingestServiceFor,
  readingAs,
  type TestIngest,
} from '../helpers/fixtures.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { AuditShipper } from '../../src/audit/audit.shipper.js';
import { ConsentDenied, ConsentService } from '../../src/consent/consent.service.js';
import { ReadService } from '../../src/records/read.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';

let db: TestDatabase;
let ingest: TestIngest;
let repository: RecordRepository;
let read: ReadService;
let audit: AuditService;

before(async () => {
  db = await startTestDatabase();
  ({ ingest, repository } = ingestServiceFor(db.app));
  audit = auditServiceFor(db.app);
  read = new ReadService(repository, new ConsentService(), audit);
});

after(async () => {
  await db.stop();
});

interface Entry {
  id: string;
  action: string;
  outcome: string;
  dataset: string;
  reason: string | null;
  actor: string | null;
  subjects: string[];
  records: string[];
  detail: Record<string, unknown> | null;
  correlation_id: string | null;
}

/** Reading the log is a privileged path, so the tests use the owner too. */
async function entries(where: string, params: unknown[] = []): Promise<Entry[]> {
  const { rows } = await db.owner.query<Entry>(
    `select id, action, outcome, dataset, reason, actor, subjects, records,
            detail, correlation_id
       from audit.entry where ${where} order by occurred_at`,
    params,
  );
  return rows;
}

/* ── the log is a statutory record, so it is append-only too ──────────── */

describe('the audit log is written by the application and owned by nobody else', () => {
  test('the application can append an entry', async () => {
    const id = uuidv7();
    await audit.record({
      action: 'record.read',
      outcome: 'allowed',
      dataset: 'live',
      actor: id,
      subjects: [id],
    });

    const written = await entries('actor = $1', [id]);
    assert.equal(written.length, 1);
  });

  test('the application cannot read the log back', async () => {
    // An application that can read the access log hands "who has been looking
    // at whom" to anyone who compromises it. Reading is a separate privileged
    // path, and the separation is a grant rather than a convention.
    const error = await db.app.query('select * from audit.entry limit 1').then(
      () => null,
      (e: unknown) => e,
    );

    assert.notEqual(error, null, 'SELECT must not succeed');
    assert.equal(sqlState(error), INSUFFICIENT_PRIVILEGE);
  });

  test('the grant is INSERT and nothing else', async () => {
    const { rows } = await db.owner.query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.role_table_grants
        where grantee = 'kernel_app' and table_schema = 'audit'`,
    );
    assert.deepEqual([...new Set(rows.map((r) => r.privilege_type))], ['INSERT']);
  });

  test('an entry cannot be edited or removed, not even by the owner', async () => {
    const actor = uuidv7();
    await audit.record({
      action: 'record.read',
      outcome: 'allowed',
      dataset: 'live',
      actor,
    });
    const [written] = await entries('actor = $1', [actor]);
    assert.ok(written);

    const update = await db.owner
      .query('update audit.entry set actor = null where id = $1', [written.id])
      .then(
        () => null,
        (e: unknown) => e,
      );
    const remove = await db.owner
      .query('delete from audit.entry where id = $1', [written.id])
      .then(
        () => null,
        (e: unknown) => e,
      );

    assert.equal(sqlState(update), RESTRICT_VIOLATION);
    assert.equal(sqlState(remove), RESTRICT_VIOLATION);
  });
});

/* ── the two statutory questions ──────────────────────────────────────── */

describe('a disclosure can be answered for afterwards', () => {
  test('DPPA s.24(1)(c) — who accessed this subject\u2019s data', async () => {
    const party = uuidv7();
    const written = await ingest.ingest(
      deliveryDocument({ asserted_by: party, to_party: party }),
    );

    await read.get(written.record.id, {
      ...readingAs(party),
      correlationId: 'c-24-1-c',
    });

    // The question is asked of the subject, not of the record, because that is
    // how a subject asks it.
    const disclosures = await entries(
      "action = 'record.read' and $1 = any(subjects)",
      [party],
    );
    assert.equal(disclosures.length, 1);
    assert.equal(disclosures[0]?.actor, party);
    assert.equal(disclosures[0]?.correlation_id, 'c-24-1-c');
  });

  test('DPPA s.16(4) — who received a record before it was corrected', async () => {
    const party = uuidv7();
    const written = await ingest.ingest(
      deliveryDocument({ asserted_by: party, to_party: party }),
    );
    await read.get(written.record.id, readingAs(party));

    const recipients = await entries(
      "action = 'record.read' and $1 = any(records)",
      [written.record.id],
    );
    assert.equal(recipients.length, 1);
    assert.equal(recipients[0]?.actor, party);
  });

  test('seed access never appears in a live disclosure list', async () => {
    // 0011. A subject asking who has seen their data must not be handed a list
    // of reads against fabricated records that merely resemble theirs.
    const party = uuidv7();
    const written = await ingest.ingest(
      deliveryDocument({ asserted_by: party, to_party: party }),
      { dataset: 'seed' },
    );
    await read.get(written.record.id, readingAs(party, 'seed'));

    // Both the append and the read are recorded, and both must be marked seed.
    const all = await entries('$1 = any(subjects)', [party]);
    assert.equal(all.length, 2);
    assert.deepEqual(
      [...new Set(all.map((entry) => entry.dataset))],
      ['seed'],
    );
    assert.equal(
      (await entries("$1 = any(subjects) and dataset = 'live'", [party])).length,
      0,
    );
  });
});

/* ── denials matter more than successes ───────────────────────────────── */

describe('every refusal is recorded with its reason', () => {
  test('a denied read is logged, and still denied', async () => {
    const owner = uuidv7();
    const stranger = uuidv7();
    const written = await ingest.ingest(
      deliveryDocument({ asserted_by: owner, to_party: owner }),
    );

    await assert.rejects(
      () => read.get(written.record.id, readingAs(stranger)),
      ConsentDenied,
      'the audit entry must not soften the refusal',
    );

    const denials = await entries("actor = $1 and outcome = 'denied'", [stranger]);
    assert.equal(denials.length, 1);
    assert.equal(denials[0]?.action, 'consent.denied');
    // The reason, not merely the fact. A shifting denial rate is only readable
    // as a signal if the reasons are distinguishable from one another.
    assert.equal(denials[0]?.reason, 'consent_not_implemented');
  });

  test('a refused write is logged against the id it claimed', async () => {
    const id = uuidv7();
    await assert.rejects(() =>
      ingest.ingest({ id, type: 'not_a_real_entity', record_class: 'observation' }),
    );

    const refusals = await entries("action = 'write.refused' and $1 = any(records)", [id]);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]?.reason, 'unknown_record_type');
    assert.equal(refusals[0]?.outcome, 'denied');
  });

  test('an append is logged as well as a refusal', async () => {
    const party = uuidv7();
    const written = await ingest.ingest(
      deliveryDocument({ asserted_by: party, to_party: party }),
    );

    const writes = await entries("action = 'record.write' and $1 = any(records)", [
      written.record.id,
    ]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.reason, 'appended');
  });
});

/* ── never a second copy of the thing it protects ─────────────────────── */

describe('the log holds ids and descriptors, never record contents', () => {
  test('a nested value cannot be smuggled into the descriptor', async () => {
    const actor = uuidv7();
    await audit.record({
      action: 'record.read',
      outcome: 'allowed',
      dataset: 'live',
      actor,
      // What a careless caller passing a record body would look like.
      detail: {
        by: 'list',
        body: { agreed_price: { amount_minor: 1150 } },
      } as never,
    });

    const [written] = await entries('actor = $1', [actor]);
    assert.ok(written);
    assert.equal(written.detail?.['body'], undefined, 'the body must be dropped');
    assert.equal(written.detail?.['by'], 'list', 'the safe keys survive');
    assert.equal(
      written.detail?.['descriptor_rejected'],
      'body',
      'and the drop is visible rather than silent',
    );
  });

  test('the database caps the descriptor even if the type is bypassed', async () => {
    const error = await db.app
      .query(
        `insert into audit.entry (id, action, outcome, dataset, detail)
         values ($1, 'record.read', 'allowed', 'live', $2)`,
        [uuidv7(), JSON.stringify({ smuggled: 'x'.repeat(4000) })],
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    assert.notEqual(error, null, 'a body-sized descriptor must be refused');
  });

  test('no column in the log can hold a record body', async () => {
    // Structural, not a promise. Every column that could carry content is a
    // uuid array or a bounded scalar; `detail` is the only jsonb and it is
    // size-capped above.
    const { rows } = await db.owner.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type
         from information_schema.columns
        where table_schema = 'audit' and table_name = 'entry'`,
    );
    const jsonb = rows.filter((r) => r.data_type === 'jsonb').map((r) => r.column_name);
    assert.deepEqual(jsonb, ['detail']);
  });

  test('the repository has no way to read the log', async () => {
    const source = await readFile(
      new URL('../../src/audit/audit.repository.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /select[\s\S]{0,200}from\s+audit\.entry/i,
      'a read on the audit table belongs in a privileged operator tool, not here',
    );
  });
});

/* ── DDL is captured, which is what makes 0016 bearable ───────────────── */

describe('the database records changes to its own shape', () => {
  test('dropping the deletion guard leaves a mark', async () => {
    // 0001 concedes an owner can drop the guard and then delete live records.
    // This is the entire mitigation: the drop is visible afterwards.
    await db.owner.query('drop trigger record_no_live_deletion on facts.record');

    const marks = await entries(
      "action = 'schema.ddl' and detail->>'object' like '%record_no_live_deletion%'",
    );
    assert.equal(marks.length, 1);
    assert.match(String(marks[0]?.reason), /^DROP /);
    assert.equal(marks[0]?.detail?.['role'], 'clycites_owner');

    // Put it back: the other invariant tests depend on it.
    await db.owner.query(
      `create trigger record_no_live_deletion
         before delete on facts.record
         for each row execute function kernel.refuse_live_deletion()`,
    );
  });

  test('creating a table leaves a mark naming the role that did it', async () => {
    await db.owner.query('create table public.audit_probe (id int primary key)');

    const marks = await entries(
      "action = 'schema.ddl' and detail->>'object' = 'public.audit_probe'",
    );
    assert.ok(marks.length >= 1);
    assert.ok(marks.some((mark) => mark.reason === 'CREATE TABLE'));
  });
});

/* ── shipping is best effort and nothing else ─────────────────────────── */

describe('the off-box copy cannot fail a request', () => {
  const shipConfig = {
    AUDIT_SHIP_URL: 'http://127.0.0.1:1/audit',
    AUDIT_SHIP_TOKEN: '',
    AUDIT_SHIP_INTERVAL_SECONDS: 1,
    AUDIT_SHIP_BATCH: 10,
  };

  test('an unreachable collector does not throw', async () => {
    const shipper = new AuditShipper(shipConfig);
    shipper.enqueue(entryShape());

    // If this rejected, the rejection would reach a request handler.
    await shipper.flush();

    assert.equal(shipper.counters.failures, 1);
    assert.equal(shipper.counters.shipped, 0);
  });

  test('entries are kept for the next attempt rather than discarded', async () => {
    const shipper = new AuditShipper(shipConfig);
    shipper.enqueue(entryShape());
    await shipper.flush();
    assert.equal(shipper.counters.dropped, 0);
  });

  test('shipping nowhere is a supported configuration', async () => {
    const shipper = new AuditShipper({ ...shipConfig, AUDIT_SHIP_URL: '' });
    shipper.enqueue(entryShape());
    await shipper.flush();

    assert.equal(shipper.enabled, false);
    assert.equal(shipper.counters.queued, 0, 'nothing is buffered for a collector that does not exist');
  });

  test('a write to the database is NOT best effort', async () => {
    // The opposite decision from shipping, and deliberately so: the database
    // copy is the statutory record, so a disclosure that cannot be recorded
    // does not happen. This is the assertion that stops somebody "fixing" the
    // flakiness by swallowing the error.
    const broken = new AuditService(
      {
        append: () => Promise.reject(new Error('audit table unreachable')),
      } as never,
      new AuditShipper({ ...shipConfig, AUDIT_SHIP_URL: '' }),
    );

    await assert.rejects(
      () =>
        broken.record({ action: 'record.read', outcome: 'allowed', dataset: 'live' }),
      /audit table unreachable/,
    );
  });
});

/* ── no disclosure path may skip the log ──────────────────────────────── */

describe('there is no way to disclose a record without recording it', () => {
  test('every consent decision in the source is next to an audit entry', async () => {
    // Derived rather than listed, so a new service that consults consent is
    // caught by this test on the day it is written rather than at the next
    // review.
    const root = new URL('../../src/', import.meta.url);
    const files: string[] = [];

    async function walk(dir: URL): Promise<void> {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const child = new URL(`${item.name}${item.isDirectory() ? '/' : ''}`, dir);
        if (item.isDirectory()) await walk(child);
        else if (item.name.endsWith('.ts')) files.push(child.pathname);
      }
    }
    await walk(root);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (file.endsWith('consent.service.ts')) continue;
      if (!/this\.consent\.(decide|assertPermitted)\(/.test(source)) continue;

      assert.match(
        source,
        /this\.audit\.record\(/,
        `${file} decides consent but writes no audit entry`,
      );
    }
  });

  test('nothing disclosing records uses the unaudited guard', async () => {
    const root = new URL('../../src/', import.meta.url);
    const files: string[] = [];

    async function walk(dir: URL): Promise<void> {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const child = new URL(`${item.name}${item.isDirectory() ? '/' : ''}`, dir);
        if (item.isDirectory()) await walk(child);
        else if (item.name.endsWith('.ts')) files.push(child.pathname);
      }
    }
    await walk(root);

    for (const file of files) {
      if (file.endsWith('consent.service.ts')) continue;
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(
        source,
        /this\.consent\.assertPermitted\(/,
        `${file} guards a disclosure without recording it — call decide() and audit the outcome`,
      );
    }
  });
});

function entryShape() {
  return {
    id: uuidv7(),
    occurred_at: new Date().toISOString(),
    action: 'record.read',
    outcome: 'allowed',
    dataset: 'live',
    reason: null,
    actor: null,
    purpose: null,
    subjects: [],
    records: [],
    record_types: [],
    detail: null,
    correlation_id: null,
  };
}
