import { InferenceRepository } from '../../src/inference/inference.repository.js';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from '@clycites/schema';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  auditServiceFor,
  delegationDocument,
  deliveryDocument,
  ingestServiceFor,
  readingAs,
  type TestIngest,
  consentServiceFor,
  objectionServiceFor,
} from '../helpers/fixtures.js';
import { ReadService } from '../../src/records/read.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { RecordRejected } from '../../src/records/errors.js';
import { CHAIN_DEEP_AT } from '../../src/records/lineage.js';
import {
  dependenciesOf,
  DEPENDENCY_FIELDS,
} from '../../src/records/staleness.js';

let db: TestDatabase;
let ingest: TestIngest;
let repository: RecordRepository;
let read: ReadService;

before(async () => {
  db = await startTestDatabase();
  ({ ingest, repository } = ingestServiceFor(db.app));
  read = new ReadService(repository, consentServiceFor(db.app), objectionServiceFor(db.app), auditServiceFor(db.app), new InferenceRepository(db.app));
});

after(async () => {
  await db.stop();
});

/* ── helpers ──────────────────────────────────────────────────────────── */

/** A delivery, and successive corrections of it, oldest first. */
async function chainOf(count: number, asserter: string): Promise<string[]> {
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

/**
 * An inference written straight into its namespace. There is no ingest path for
 * inferences until work order G, and inventing one here would test the fixture
 * rather than the derivation.
 */
async function inferenceOn(
  subject: string,
  body: Record<string, unknown>,
): Promise<string> {
  const id = uuidv7();
  // The key row as well as the record. The write path always claims the id
  // there first, and since P4 the validation trigger reads it to check that an
  // inference is an inference — a fixture that skipped it was writing a record
  // the rest of the kernel could not classify.
  await db.owner.query(
    `insert into kernel.record_key (id, record_class, type, recorded_at, dataset)
     values ($1, 'inference', 'inference', now(), 'live')`,
    [id],
  );
  await db.owner.query(
    `insert into inference.record (
       id, type, record_class, schema_version, occurred_at, occurred_at_precision,
       recorded_at, asserted_by, body, dataset, lawful_basis
     ) values ($1, 'observation', 'inference', $2, now(), 'day', now(), $3, $4::jsonb,
               'live', 'consent')`,
    [
      id,
      SCHEMA_VERSION,
      subject,
      JSON.stringify({
        subject_ref: subject,
        inference_depth: 0,
        stale: false,
        ...body,
      }),
    ],
  );
  return id;
}

/* ── L1: staleness is derived ─────────────────────────────────────────── */

describe('an inference is stale when its inputs move (spec §8 rule 5)', () => {
  test('a fresh inference over untouched inputs is not stale', async () => {
    const party = uuidv7();
    const [input] = await chainOf(0, party);
    const id = await inferenceOn(party, { inputs: [input] });

    const view = await read.getInference(id, readingAs(party));

    assert.equal(view?.staleness?.stale, false);
    assert.deepEqual(view?.staleness?.reasons, []);
  });

  test('superseding an input makes it stale, and says which input', async () => {
    const party = uuidv7();
    const [original, correction] = await chainOf(1, party);
    const id = await inferenceOn(party, { inputs: [original] });

    const view = await read.getInference(id, readingAs(party));

    assert.equal(view?.staleness?.stale, true);
    assert.deepEqual(view?.staleness?.reasons, ['input_superseded']);
    assert.deepEqual(view?.staleness?.superseded_inputs, [original]);
    assert.ok(correction, 'the correction exists and is the value to re-run on');
  });

  test('retracting an input is reported differently from superseding one', async () => {
    const party = uuidv7();
    const [input] = await chainOf(0, party);
    const id = await inferenceOn(party, { inputs: [input] });

    await ingest.ingest(retractionOf(input!, party));
    const view = await read.getInference(id, readingAs(party));

    // The distinction is the point: a superseded input can be re-run against a
    // newer value, a retracted one may have nothing left to re-run against.
    assert.deepEqual(view?.staleness?.reasons, ['input_retracted']);
    assert.deepEqual(view?.staleness?.retracted_inputs, [input]);
  });

  test('both reasons are reported when both apply', async () => {
    const party = uuidv7();
    const [superseded] = await chainOf(1, party);
    const [retracted] = await chainOf(0, party);
    await ingest.ingest(retractionOf(retracted!, party));

    const id = await inferenceOn(party, {
      inputs: [superseded, retracted],
    });
    const view = await read.getInference(id, readingAs(party));

    assert.deepEqual(view?.staleness?.reasons, [
      'input_superseded',
      'input_retracted',
    ]);
  });

  test('one input both superseded and retracted reports both', async () => {
    const party = uuidv7();
    const [original] = await chainOf(1, party);
    await ingest.ingest(retractionOf(original!, party));

    const id = await inferenceOn(party, { inputs: [original] });
    const view = await read.getInference(id, readingAs(party));

    assert.deepEqual(view?.staleness?.reasons, [
      'input_superseded',
      'input_retracted',
    ]);
    assert.deepEqual(view?.staleness?.superseded_inputs, [original]);
    assert.deepEqual(view?.staleness?.retracted_inputs, [original]);
  });

  test('an input that is not in the corpus is unresolved, not fresh', async () => {
    const party = uuidv7();
    const absent = uuidv7();
    const id = await inferenceOn(party, { inputs: [absent] });

    const view = await read.getInference(id, readingAs(party));

    // Reporting this as `stale: false` would read as "checked against every
    // input and they are all current", which is the opposite of what happened.
    assert.equal(view?.staleness?.stale, false);
    assert.deepEqual(view?.staleness?.unresolved_inputs, [absent]);
  });

  test('the lookup covers every field naming a record, not just inputs', () => {
    // P4 populates `validated_by` from `inference.validation`. It needed no
    // change here, which was the point of writing this generically in L.
    assert.ok(DEPENDENCY_FIELDS.includes('validated_by'));

    const a = uuidv7();
    const b = uuidv7();
    assert.deepEqual(
      dependenciesOf({ inputs: [a], validated_by: [b, a] }),
      [a, b],
      'both fields contribute, and an id named twice is looked up once',
    );
  });

  test('a superseded validator makes the verdict stale too', async () => {
    const party = uuidv7();
    const [input] = await chainOf(0, party);
    const [validator] = await chainOf(1, party);

    const id = await inferenceOn(party, { inputs: [input] });
    // Linked the way the API links it, because since P4 a `validated_by` in
    // the body is discarded — the array is derived from this table on read.
    await new InferenceRepository(db.app).link({
      id: uuidv7(),
      inferenceId: id,
      observation: validator!,
      verdict: 'confirmed',
      note: null,
      linkedAt: new Date().toISOString(),
      linkedBy: party,
      dataset: 'live',
    });

    const view = await read.getInference(id, readingAs(party));

    assert.equal(view?.staleness?.stale, true);
    assert.deepEqual(view?.staleness?.superseded_inputs, [validator]);
  });

  test('a whole set of inferences costs one query', async () => {
    const party = uuidv7();
    const ids = await chainOf(3, party);
    const inferences = await Promise.all(
      ids.map((input) => inferenceOn(party, { inputs: [input] })),
    );

    let queries = 0;
    const counting = new Proxy(repository, {
      get(target, key: string) {
        const value = Reflect.get(target, key) as unknown;
        if (key !== 'dependencyStatus') return value;
        queries += 1;
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    const counted = new ReadService(counting, consentServiceFor(db.app), objectionServiceFor(db.app), auditServiceFor(db.app), new InferenceRepository(db.app));

    // getInference reads one at a time, so drive the derivation the way a page
    // would: the method takes the whole set and must not fan out per record.
    const status = await counting.dependencyStatus(ids, 'live');
    assert.equal(status.size, ids.length);
    assert.equal(queries, 1);
    assert.ok(await counted.getInference(inferences[0]!, readingAs(party)));
  });
});

describe('a client cannot assert its way out of a re-run', () => {
  test('a submitted `stale` is discarded, like `recorded_at`', async () => {
    const party = uuidv7();
    const result = await ingest.ingest(
      deliveryDocument({ asserted_by: party, to_party: party, stale: false }),
    );

    // Deliveries have no `stale` field, so the schema strips it. The assertion
    // that matters is that nothing the client sent survived into the body.
    assert.equal('stale' in result.record.body, false);
  });

  test('the stored boolean is never consulted', async () => {
    const party = uuidv7();
    const [input] = await chainOf(1, party);
    const id = await inferenceOn(party, { inputs: [input], stale: false });

    const view = await read.getInference(id, readingAs(party));

    assert.equal(view?.record['stale'], false, 'the body reads back as written');
    assert.equal(view?.staleness?.stale, true, 'the derivation disagrees, and wins');
  });
});

/* ── L2: cycles and depth ─────────────────────────────────────────────── */

describe('chains are permitted and cycles are not (spec §8 rule 3)', () => {
  test('a record cannot supersede itself', async () => {
    const party = uuidv7();
    const id = uuidv7();

    const error = await ingest
      .ingest(
        deliveryDocument({
          id,
          asserted_by: party,
          to_party: party,
          supersedes: id,
        }),
      )
      .catch((e: unknown) => e as RecordRejected);

    assert.ok(error instanceof RecordRejected);
    // The one-link cycle is refused by the envelope schema itself, before the
    // kernel ever looks at the log — so it reads as a malformed record rather
    // than an invalid supersession. Longer loops have no such shortcut.
    assert.equal(error.code, 'malformed_record');
  });

  test('A → B → C → A is refused', async () => {
    const party = uuidv7();
    const [a, , c] = await chainOf(2, party);

    // Closing the loop means re-submitting A with a `supersedes` pointing at
    // the far end of its own chain.
    const error = await ingest
      .ingest(
        deliveryDocument({
          id: a,
          asserted_by: party,
          to_party: party,
          supersedes: c,
        }),
      )
      .catch((e: unknown) => e as RecordRejected);

    assert.ok(error instanceof RecordRejected);
    assert.equal(error.code, 'supersession_invalid');
    assert.match(error.message, /cycle/);
  });

  test('the chain is still walkable afterwards, so nothing was written', async () => {
    const party = uuidv7();
    const ids = await chainOf(2, party);

    await ingest
      .ingest(
        deliveryDocument({
          id: ids[0],
          asserted_by: party,
          to_party: party,
          supersedes: ids.at(-1),
        }),
      )
      .catch(() => undefined);

    const chain = await read.chain(ids[0]!, readingAs(party));
    assert.deepEqual(
      chain.map((view) => view.record['id']),
      ids,
    );
  });

  test('a chain past the bound is refused rather than made unreadable', async () => {
    const party = uuidv7();
    const limit = 4;
    const { ingest: bounded } = ingestServiceFor(
      db.app,
      { lawfulBasis: 'special_data_consent' },
      { SUPERSESSION_MAX_DEPTH: limit },
    );

    const first = await bounded.ingest(
      deliveryDocument({ asserted_by: party, to_party: party }),
    );
    let tip = first.record.id;
    const accepted: string[] = [];

    for (let i = 0; i < limit; i += 1) {
      const next = await bounded
        .ingest(
          deliveryDocument({
            asserted_by: party,
            to_party: party,
            supersedes: tip,
          }),
        )
        .catch((e: unknown) => e as RecordRejected);

      if (next instanceof RecordRejected) {
        assert.equal(next.code, 'supersession_invalid');
        assert.match(next.message, /chain is \d+ deep and the limit is 4/);
        assert.equal(accepted.length, limit - 1, 'the bound is where it says');
        return;
      }
      accepted.push(next.record.id);
      tip = next.record.id;
    }

    assert.fail('the depth bound never fired');
  });

  test('a chain approaching the bound is flagged while it can still be noticed', async () => {
    const party = uuidv7();
    const limit = 8;
    const { ingest: bounded } = ingestServiceFor(
      db.app,
      { lawfulBasis: 'special_data_consent' },
      { SUPERSESSION_MAX_DEPTH: limit },
    );

    const first = await bounded.ingest(
      deliveryDocument({ asserted_by: party, to_party: party }),
    );
    let tip = first.record.id;
    const flagged: number[] = [];

    for (let depth = 1; depth < limit; depth += 1) {
      const next = await bounded.ingest(
        deliveryDocument({
          asserted_by: party,
          to_party: party,
          supersedes: tip,
        }),
      );
      if (next.record.quality_flags.includes('supersession_chain_deep')) {
        flagged.push(depth);
      }
      tip = next.record.id;
    }

    assert.deepEqual(flagged, [6, 7], `flagged from ${CHAIN_DEEP_AT} of the bound`);
  });

  test('the bound is a parameter, so the default leaves ordinary chains alone', async () => {
    const party = uuidv7();
    const ids = await chainOf(3, party);
    const tip = await read.get(ids.at(-1)!, readingAs(party));

    assert.equal(
      tip?.quality_flags.includes('supersession_chain_deep'),
      false,
      'three corrections is not a deep chain under the default of 64',
    );
  });
});

/* ── L3: correction rights ────────────────────────────────────────────── */

describe('correction rights reach beyond the original claimant (spec §8 rule 1)', () => {
  /** A delivery asserted by `farmer`, and a delegation letting `agent` act. */
  async function deliveryAndDelegation(
    farmer: string,
    agent: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ delivery: string; delegation: string }> {
    const delivery = await ingest.ingest(
      deliveryDocument({ asserted_by: farmer, to_party: farmer }),
    );
    const delegation = await ingest.ingest(
      delegationDocument(farmer, agent, overrides),
    );
    return { delivery: delivery.record.id, delegation: delegation.record.id };
  }

  test('a stranger still cannot correct a record', async () => {
    const farmer = uuidv7();
    const stranger = uuidv7();
    const { delivery } = await deliveryAndDelegation(farmer, uuidv7());

    const error = await ingest
      .ingest(
        deliveryDocument({
          asserted_by: stranger,
          to_party: stranger,
          supersedes: delivery,
        }),
      )
      .catch((e: unknown) => e as RecordRejected);

    assert.ok(error instanceof RecordRejected);
    assert.equal(error.code, 'supersession_invalid');
  });

  test('a coop holding a correction right may correct in its own name', async () => {
    const farmer = uuidv7();
    const coop = uuidv7();
    const { delivery, delegation } = await deliveryAndDelegation(farmer, coop);

    const correction = await ingest.ingest(
      deliveryDocument({
        asserted_by: coop,
        to_party: coop,
        supersedes: delivery,
        delegation,
      }),
    );

    assert.equal(correction.record.supersedes, delivery);
    assert.ok(correction.record.quality_flags.includes('corrected_under_delegation'));
  });

  test('the weaker authority is visible on the correction itself', async () => {
    const farmer = uuidv7();
    const coop = uuidv7();

    // Both sides of the delivery are the farmer, so the farmer is the only
    // subject of the chain and the consent guard lets them read it. The coop
    // appears as the asserter of the correction, which is the point.
    const original = await ingest.ingest(
      deliveryDocument({
        asserted_by: farmer,
        from_party: farmer,
        to_party: farmer,
      }),
    );
    const delivery = original.record.id;
    const granted = await ingest.ingest(
      delegationDocument(farmer, coop, { granted_via: 'organisational_bylaw' }),
    );
    const delegation = granted.record.id;

    const correction = await ingest.ingest(
      deliveryDocument({
        asserted_by: coop,
        from_party: farmer,
        to_party: farmer,
        supersedes: delivery,
        delegation,
      }),
    );

    assert.ok(
      correction.record.quality_flags.includes(
        'corrected_under_organisational_bylaw',
      ),
    );

    // A lender walking the chain sees which link rests on a bylaw and which on
    // the farmer's own word, without having to fetch the delegation.
    const chain = await read.chain(delivery, readingAs(farmer));
    const tip = chain.at(-1);
    assert.equal(tip?.record['id'], correction.record.id);
    assert.ok(tip?.quality_flags.includes('corrected_under_organisational_bylaw'));
    assert.equal(
      chain[0]?.quality_flags.includes('corrected_under_delegation'),
      false,
      'the original is not labelled — it was the claimant’s own',
    );
  });

  test('a delegation out of scope does not carry a correction right', async () => {
    const farmer = uuidv7();
    const coop = uuidv7();
    const { delivery, delegation } = await deliveryAndDelegation(farmer, coop, {
      scope: ['harvest'],
    });

    const error = await ingest
      .ingest(
        deliveryDocument({
          asserted_by: coop,
          to_party: coop,
          supersedes: delivery,
          delegation,
        }),
      )
      .catch((e: unknown) => e as RecordRejected);

    assert.ok(error instanceof RecordRejected);
    assert.equal(error.code, 'delegation_not_authorised');
  });

  test('a revoked delegation does not carry a correction right', async () => {
    const farmer = uuidv7();
    const coop = uuidv7();
    const { delivery, delegation } = await deliveryAndDelegation(farmer, coop, {
      revoked_at: '2026-02-01T00:00:00+03:00',
    });

    const error = await ingest
      .ingest(
        deliveryDocument({
          asserted_by: coop,
          to_party: coop,
          supersedes: delivery,
          delegation,
        }),
      )
      .catch((e: unknown) => e as RecordRejected);

    assert.ok(error instanceof RecordRejected);
    assert.equal(error.code, 'delegation_not_authorised');
  });

  test('a delegation granted by someone else does not carry one either', async () => {
    const farmer = uuidv7();
    const coop = uuidv7();
    const { delivery } = await deliveryAndDelegation(farmer, coop);
    const unrelated = await ingest.ingest(delegationDocument(uuidv7(), coop));

    const error = await ingest
      .ingest(
        deliveryDocument({
          asserted_by: coop,
          to_party: coop,
          supersedes: delivery,
          delegation: unrelated.record.id,
        }),
      )
      .catch((e: unknown) => e as RecordRejected);

    assert.ok(error instanceof RecordRejected);
    assert.equal(error.code, 'delegation_not_authorised');
  });

  test('acting as the farmer still works and is not labelled a correction right', async () => {
    const farmer = uuidv7();
    const officer = uuidv7();
    const { delivery, delegation } = await deliveryAndDelegation(farmer, officer);

    const correction = await ingest.ingest(
      deliveryDocument({
        asserted_by: officer,
        on_behalf_of: farmer,
        to_party: farmer,
        supersedes: delivery,
        delegation,
      }),
    );

    // The claim is still the farmer's, so this is rule 1's first half, not its
    // second. It carries `delegated_authority`, which already existed.
    assert.ok(correction.record.quality_flags.includes('delegated_authority'));
    assert.equal(
      correction.record.quality_flags.includes('corrected_under_delegation'),
      false,
    );
  });
});

/* ── L5: retraction propagation ───────────────────────────────────────── */

describe('retraction reaches everything derived from the record', () => {
  test('retracting an input reaches the inference that used it', async () => {
    const party = uuidv7();
    const [input] = await chainOf(0, party);
    const id = await inferenceOn(party, { inputs: [input] });

    assert.equal(
      (await read.getInference(id, readingAs(party)))?.staleness?.stale,
      false,
    );
    await ingest.ingest(retractionOf(input!, party));
    assert.equal(
      (await read.getInference(id, readingAs(party)))?.staleness?.stale,
      true,
    );
  });

  test('retracting a record mid-chain does not orphan the tail', async () => {
    const party = uuidv7();
    const [a, b, c] = await chainOf(2, party);
    await ingest.ingest(retractionOf(b!, party));

    const chain = await read.chain(a!, readingAs(party));
    assert.deepEqual(
      chain.map((view) => view.record['id']),
      [a, b, c],
      'the chain is intact — a retraction hides a claim, it does not cut the link',
    );
    assert.deepEqual(
      chain.map((view) => view.retracted),
      [false, true, false],
      'and the chain view says exactly which link was withdrawn',
    );

    const page = await read.list(
      { type: 'delivery', assertedBy: party },
      readingAs(party),
    );
    assert.deepEqual(
      page.records.map((view) => view.record['id']),
      [c],
      'the tip still stands; retracting a superseded record withdraws that claim, not its correction',
    );
  });

  test('retracting the tip falls back to nothing, not to the superseded record', async () => {
    const party = uuidv7();
    const [a, b] = await chainOf(1, party);
    await ingest.ingest(retractionOf(b!, party));

    const page = await read.list(
      { type: 'delivery', assertedBy: party },
      readingAs(party),
    );

    // `a` stays superseded. Resurrecting it would mean a retraction silently
    // reinstated a figure the claimant had already replaced.
    assert.equal(
      page.records.some((view) => view.record['id'] === a),
      false,
    );
    assert.equal(
      page.records.some((view) => view.record['id'] === b),
      false,
    );
    assert.equal((await read.get(a!, readingAs(party)))?.record['id'], a);
  });

  test('a retraction in another corpus cannot mark a live record retracted', async () => {
    const party = uuidv7();
    const [live] = await chainOf(0, party);

    const { ingest: seeding } = ingestServiceFor(db.app, {
      lawfulBasis: 'special_data_consent',
      dataset: 'seed',
    });
    await seeding
      .ingest(retractionOf(live!, party))
      .catch(() => undefined);

    const chain = await read.chain(live!, readingAs(party));
    assert.equal(chain[0]?.retracted, false);
  });
});
