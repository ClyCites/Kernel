import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  delegationDocument,
  deliveryDocument,
  ingestServiceFor,
  type TestIngest,
} from '../helpers/fixtures.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { RecordRejected } from '../../src/records/errors.js';

let db: TestDatabase;
let ingest: TestIngest;
let repository: RecordRepository;

before(async () => {
  db = await startTestDatabase();
  ({ ingest, repository } = ingestServiceFor(db.app));
});

after(async () => {
  await db.stop();
});

async function rejection(promise: Promise<unknown>): Promise<RecordRejected> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(error instanceof RecordRejected, `expected a rejection, got ${error}`);
  return error;
}

/* ── idempotency ──────────────────────────────────────────────────────── */

describe('ingest is idempotent on the record id (brief §4.5)', () => {
  test('the same delivery submitted three times produces one row', async () => {
    const document = deliveryDocument();

    const first = await ingest.ingest(document);
    const second = await ingest.ingest(document);
    const third = await ingest.ingest(document);

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(third.replayed, true);

    const { rows } = await db.app.query<{ count: string }>(
      'select count(*)::text as count from facts.record where id = $1',
      [document['id']],
    );
    assert.equal(rows[0]?.count, '1');
  });

  test('a replay returns the record as originally stored', async () => {
    const document = deliveryDocument();

    const first = await ingest.ingest(document);
    const replay = await ingest.ingest(document);

    assert.equal(replay.record.recorded_at, first.record.recorded_at);
    assert.equal(replay.record.id, first.record.id);
  });

  test('reusing an id for a different record is refused', async () => {
    const document = deliveryDocument();
    await ingest.ingest(document);

    const error = await rejection(
      ingest.ingest({ ...document, commodity: 'crop.beans.dry' }),
    );

    assert.equal(error.code, 'id_conflict');
  });
});

/* ── provenance ───────────────────────────────────────────────────────── */

describe('provenance is mandatory (brief §4.3)', () => {
  test('a delivery with on_behalf_of and no delegation is refused', async () => {
    const error = await rejection(
      ingest.ingest(deliveryDocument({ on_behalf_of: uuidv7() })),
    );

    assert.equal(error.code, 'malformed_record');
    assert.ok(
      error.issues.some((issue) => issue.path === 'delegation'),
      'the schema itself refuses on_behalf_of without a delegation',
    );
  });

  test('a delegation that is not in the log does not authorise anything', async () => {
    const error = await rejection(
      ingest.ingest(
        deliveryDocument({ on_behalf_of: uuidv7(), delegation: uuidv7() }),
      ),
    );

    assert.equal(error.code, 'delegation_not_authorised');
  });

  test('a delegation in scope and in date authorises the record', async () => {
    const farmer = uuidv7();
    const officer = uuidv7();
    const delegation = await ingest.ingest(
      delegationDocument(farmer, officer),
    );

    const result = await ingest.ingest(
      deliveryDocument({
        asserted_by: officer,
        from_party: farmer,
        on_behalf_of: farmer,
        delegation: delegation.record.id,
      }),
    );

    assert.equal(result.replayed, false);
    assert.ok(result.record.quality_flags.includes('delegated_authority'));
  });

  test('a delegation that does not cover this record type is refused', async () => {
    const farmer = uuidv7();
    const officer = uuidv7();
    const delegation = await ingest.ingest(
      delegationDocument(farmer, officer, { scope: ['harvest'] }),
    );

    const error = await rejection(
      ingest.ingest(
        deliveryDocument({
          asserted_by: officer,
          on_behalf_of: farmer,
          delegation: delegation.record.id,
        }),
      ),
    );

    assert.equal(error.code, 'delegation_not_authorised');
    assert.match(error.message, /does not cover "delivery"/);
  });

  test('a delegation revoked before the delivery is refused', async () => {
    const farmer = uuidv7();
    const officer = uuidv7();
    const delegation = await ingest.ingest(
      delegationDocument(farmer, officer, {
        revoked_at: '2026-05-01T00:00:00+03:00',
      }),
    );

    const error = await rejection(
      ingest.ingest(
        deliveryDocument({
          asserted_by: officer,
          on_behalf_of: farmer,
          delegation: delegation.record.id,
        }),
      ),
    );

    assert.match(error.message, /revoked/);
  });

  test('a delegation granted after the delivery is refused', async () => {
    const farmer = uuidv7();
    const officer = uuidv7();
    const delegation = await ingest.ingest(
      delegationDocument(farmer, officer, {
        granted_at: '2026-12-01T00:00:00+03:00',
      }),
    );

    const error = await rejection(
      ingest.ingest(
        deliveryDocument({
          asserted_by: officer,
          on_behalf_of: farmer,
          delegation: delegation.record.id,
        }),
      ),
    );

    assert.match(error.message, /predates the delegation/);
  });

  test('authority granted by bylaw is labelled as the weaker evidence it is', async () => {
    const farmer = uuidv7();
    const coop = uuidv7();
    const delegation = await ingest.ingest(
      delegationDocument(farmer, coop, { granted_via: 'organisational_bylaw' }),
    );

    const result = await ingest.ingest(
      deliveryDocument({
        asserted_by: coop,
        on_behalf_of: farmer,
        delegation: delegation.record.id,
      }),
    );

    assert.ok(
      result.record.quality_flags.includes('delegated_by_organisational_bylaw'),
      'spec §5.3 requires bylaw-derived authority to be labelled wherever surfaced',
    );
  });
});

/* ── flag, never reject ───────────────────────────────────────────────── */

describe('flag, never reject (brief §4.4)', () => {
  test('an implausible quantity is stored, with a flag', async () => {
    const result = await ingest.ingest(
      deliveryDocument({
        quantity: {
          raw_value: 40_000,
          raw_unit: 'bag',
          normalized_kg: 4_720_000,
          conversion_id: uuidv7(),
          measurement_method: 'coop_weighed',
        },
      }),
    );

    assert.equal(result.replayed, false);
    assert.ok(result.record.quality_flags.includes('quantity_implausible_high'));

    const stored = await repository.findById(result.record.id);
    assert.ok(stored, 'the record must be in the log, not refused');
    assert.ok(stored.quality_flags.includes('quantity_implausible_high'));
  });

  test('a quantity with no conversion available is stored, with a flag', async () => {
    const result = await ingest.ingest(
      deliveryDocument({
        quantity: {
          raw_value: 3,
          raw_unit: 'basin',
          raw_unit_label: 'debe',
          measurement_method: 'self_reported',
        },
      }),
    );

    assert.deepEqual(result.record.quality_flags, [
      'measurement_below_underwritable',
      'quantity_not_normalized',
    ]);
  });

  test('a delivery from a party to itself is stored, with a flag', async () => {
    const same = uuidv7();
    const result = await ingest.ingest(
      deliveryDocument({ asserted_by: same, from_party: same, to_party: same }),
    );

    assert.ok(result.record.quality_flags.includes('delivery_parties_identical'));
  });

  test('a confirmation from someone who was not there is stored, with a flag', async () => {
    const result = await ingest.ingest(
      deliveryDocument({
        counterparty_confirmed_at: '2026-07-18T14:35:02+03:00',
        counterparty_confirmed_by: uuidv7(),
      }),
    );

    assert.ok(
      result.record.quality_flags.includes('confirmation_by_uninvolved_party'),
    );
  });

  test('flags never appear inside the record body', async () => {
    const result = await ingest.ingest(
      deliveryDocument({
        quantity: {
          raw_value: 40_000,
          raw_unit: 'bag',
          measurement_method: 'self_reported',
        },
      }),
    );

    assert.ok(result.record.quality_flags.length > 0);
    const quantity = result.record.body['quantity'] as Record<string, unknown>;
    assert.deepEqual(
      quantity['quality_flags'],
      [],
      'the kernel does not edit a claim it was given',
    );
  });
});

/* ── structural rejections ────────────────────────────────────────────── */

describe('structural failures are refused', () => {
  test('an unknown record type is refused', async () => {
    const error = await rejection(
      ingest.ingest(deliveryDocument({ type: 'shipment' })),
    );
    assert.equal(error.code, 'unknown_record_type');
  });

  test('a missing occurred_at_precision is refused, because it has no default', async () => {
    const document = deliveryDocument();
    delete document['occurred_at_precision'];

    const error = await rejection(ingest.ingest(document));

    assert.equal(error.code, 'malformed_record');
    assert.ok(
      error.issues.some((issue) => issue.path === 'occurred_at_precision'),
    );
  });

  test('a quantity with no measurement method is refused', async () => {
    const error = await rejection(
      ingest.ingest(
        deliveryDocument({
          quantity: { raw_value: 12, raw_unit: 'bag' },
        }),
      ),
    );
    assert.equal(error.code, 'malformed_record');
  });

  test('a normalized weight with no conversion reference is refused', async () => {
    const error = await rejection(
      ingest.ingest(
        deliveryDocument({
          quantity: {
            raw_value: 12,
            raw_unit: 'bag',
            normalized_kg: 1416,
            measurement_method: 'coop_weighed',
          },
        }),
      ),
    );

    assert.equal(error.code, 'malformed_record');
    assert.ok(error.issues.some((issue) => issue.path === 'quantity.conversion_id'));
  });

  test('an inference cannot be submitted as a delivery', async () => {
    const error = await rejection(
      ingest.ingest(deliveryDocument({ record_class: 'inference' })),
    );
    assert.equal(error.code, 'malformed_record');
  });
});

/* ── the kernel owns recorded_at ──────────────────────────────────────── */

describe('recorded_at is set by the kernel (spec §4)', () => {
  test('a client-supplied recorded_at is discarded', async () => {
    const result = await ingest.ingest(
      deliveryDocument({ recorded_at: '2001-01-01T00:00:00+03:00' }),
    );

    assert.notEqual(Date.parse(result.record.recorded_at), Date.parse('2001-01-01T00:00:00+03:00'));
    assert.ok(Date.parse(result.record.recorded_at) > Date.parse('2026-01-01T00:00:00Z'));
  });
});

/* ── supersession at ingest ───────────────────────────────────────────── */

describe('corrections (spec §8)', () => {
  test('a correction by the original claimant is accepted', async () => {
    const original = await ingest.ingest(deliveryDocument());

    const correction = await ingest.ingest(
      deliveryDocument({
        asserted_by: original.record.asserted_by,
        from_party: original.record.body['from_party'],
        to_party: original.record.body['to_party'],
        supersedes: original.record.id,
      }),
    );

    assert.equal(correction.record.supersedes, original.record.id);
  });

  test('a correction from a different party is refused', async () => {
    const original = await ingest.ingest(deliveryDocument());

    const error = await rejection(
      ingest.ingest(deliveryDocument({ supersedes: original.record.id })),
    );

    assert.equal(error.code, 'supersession_invalid');
  });

  test('superseding a record that is not in the log is refused', async () => {
    const error = await rejection(
      ingest.ingest(deliveryDocument({ supersedes: uuidv7() })),
    );
    assert.equal(error.code, 'supersession_invalid');
  });

  test('a delivery cannot supersede a delegation', async () => {
    const delegation = await ingest.ingest(
      delegationDocument(uuidv7(), uuidv7()),
    );

    const error = await rejection(
      ingest.ingest(
        deliveryDocument({
          asserted_by: delegation.record.asserted_by,
          supersedes: delegation.record.id,
        }),
      ),
    );

    assert.equal(error.code, 'supersession_invalid');
  });
});
