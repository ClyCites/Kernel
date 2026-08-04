import { after, before, describe, test } from 'node:test';
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
  ingestServiceFor,
  entityDocument,
  retractionDocument,
} from '../helpers/fixtures.js';
import { InferenceRepository } from '../../src/inference/inference.repository.js';
import {
  InferenceService,
  INFERENCE_DEPTH_EXCEEDED,
  INFERENCE_DEPTH_MISSTATED,
  INFERENCE_INPUT_UNRESOLVED,
} from '../../src/inference/inference.service.js';
import { TrainingRepository } from '../../src/training/training.repository.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { ReadService } from '../../src/records/read.service.js';
import { RecordRejected } from '../../src/records/errors.js';

let db: TestDatabase;
let inferences: InferenceService;
let read: ReadService;
let ingest: ReturnType<typeof ingestServiceFor>['ingest']['ingest'];

const MODEL_PARTY = uuidv7();
const SUBJECT = MODEL_PARTY;

function prediction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuidv7(),
    type: 'inference',
    record_class: 'inference',
    schema_version: '0.2.0',
    occurred_at: new Date().toISOString(),
    occurred_at_precision: 'day',
    asserted_by: MODEL_PARTY,
    model_id: 'yield-net',
    model_version: '1.0.0',
    inference_type: 'yield.predicted',
    subject_type: 'party',
    subject_ref: SUBJECT,
    inputs: [],
    output: { kind: 'scalar', value: 1200, unit: 'kg' },
    inference_depth: 0,
    ...overrides,
  };
}

/** A real observation, so the depth arithmetic has something to stand on. */
async function observation(): Promise<string> {
  const document = entityDocument('harvest', { asserted_by: MODEL_PARTY });
  const { record } = await ingest(document, { lawfulBasis: 'consent' });
  return record.id;
}

before(async () => {
  db = await startTestDatabase();
  const repository = new RecordRepository(db.app);
  const validations = new InferenceRepository(db.app);
  ingest = ingestServiceFor(db.app).ingest.ingest;
  inferences = new InferenceService(repository, validations, auditServiceFor(db.app));
  read = new ReadService(
    repository,
    consentServiceFor(db.app),
    objectionServiceFor(db.app),
    auditServiceFor(db.app),
    validations,
  );
});

after(async () => {
  await db.stop();
});

describe('depth is the kernel arithmetic, not the client claim', () => {
  test('every input an observation makes the depth 0', async () => {
    const input = await observation();
    const { record } = await inferences.append(
      prediction({ inputs: [input], inference_depth: 7 }),
      { lawfulBasis: 'consent' },
    );

    assert.equal(record.body['inference_depth'], 0);
    // Flagged, not refused: the record is still what the model produced.
    assert.ok(record.quality_flags.includes(INFERENCE_DEPTH_MISSTATED));
    assert.ok(!record.quality_flags.includes(INFERENCE_DEPTH_EXCEEDED));
  });

  test('an inference over an inference is depth 1 and one over that is flagged', async () => {
    const input = await observation();
    const first = await inferences.append(prediction({ inputs: [input] }), {
      lawfulBasis: 'consent',
    });
    const second = await inferences.append(
      prediction({ inputs: [first.record.id] }),
      { lawfulBasis: 'consent' },
    );
    assert.equal(second.record.body['inference_depth'], 1);
    assert.ok(!second.record.quality_flags.includes(INFERENCE_DEPTH_EXCEEDED));

    const third = await inferences.append(
      prediction({ inputs: [second.record.id] }),
      { lawfulBasis: 'consent' },
    );
    assert.equal(third.record.body['inference_depth'], 2);
    assert.ok(third.record.quality_flags.includes(INFERENCE_DEPTH_EXCEEDED));
  });

  test('an input nobody has is named rather than assumed to be an observation', async () => {
    const { record } = await inferences.append(prediction({ inputs: [uuidv7()] }), {
      lawfulBasis: 'consent',
    });
    assert.ok(record.quality_flags.includes(INFERENCE_INPUT_UNRESOLVED));
  });

  test('a submitted validated_by or stale is discarded', async () => {
    const input = await observation();
    const { record } = await inferences.append(
      prediction({ inputs: [input], validated_by: [uuidv7()], stale: true }),
      { lawfulBasis: 'consent' },
    );
    assert.deepEqual(record.body['validated_by'], []);
    assert.equal(record.body['stale'], false);
  });

  test('an inference without a stated ground is refused', async () => {
    await assert.rejects(
      () => inferences.append(prediction({ inputs: [uuidv7()] }), {}),
      (error: unknown) =>
        error instanceof RecordRejected && error.code === 'lawful_basis_required',
    );
  });
});

describe('a prediction acquires a verdict and stays a prediction', () => {
  test('the observation that settled it is linked, and read back beside it', async () => {
    const input = await observation();
    const { record } = await inferences.append(prediction({ inputs: [input] }), {
      lawfulBasis: 'consent',
    });
    const settled = await observation();

    await inferences.validate({
      inference: record.id,
      observation: settled,
      verdict: 'confirmed',
      note: 'the August delivery came in within 3% of the March forecast',
      linkedBy: MODEL_PARTY,
      dataset: 'live',
    });

    const view = await read.getInference(record.id, { requester: MODEL_PARTY });
    assert.ok(view !== null);
    assert.deepEqual(view.record['validated_by'], [settled]);
    assert.equal(view.validation?.[0]?.verdict, 'confirmed');
  });

  test('linking the same pair twice adds nothing', async () => {
    const input = await observation();
    const { record } = await inferences.append(prediction({ inputs: [input] }), {
      lawfulBasis: 'consent',
    });
    const settled = await observation();

    const first = await inferences.validate({
      inference: record.id,
      observation: settled,
      verdict: 'inconclusive',
      note: null,
      linkedBy: MODEL_PARTY,
      dataset: 'live',
    });
    const again = await inferences.validate({
      inference: record.id,
      observation: settled,
      verdict: 'contradicted',
      note: null,
      linkedBy: MODEL_PARTY,
      dataset: 'live',
    });

    // The first verdict stands. An evaluation set that could be revised by
    // replaying a request is not evidence of anything.
    assert.equal(again.id, first.id);
    assert.equal(again.verdict, 'inconclusive');
  });

  test('a validator must be an observation, not another prediction', async () => {
    const input = await observation();
    const { record } = await inferences.append(prediction({ inputs: [input] }), {
      lawfulBasis: 'consent',
    });
    const other = await inferences.append(prediction({ inputs: [input] }), {
      lawfulBasis: 'consent',
    });

    await assert.rejects(() =>
      inferences.validate({
        inference: record.id,
        observation: other.record.id,
        verdict: 'confirmed',
        note: null,
        linkedBy: MODEL_PARTY,
        dataset: 'live',
      }),
    );
  });

  test('the prediction is never promoted into the fact log', async () => {
    const input = await observation();
    const { record } = await inferences.append(prediction({ inputs: [input] }), {
      lawfulBasis: 'consent',
    });
    await inferences.validate({
      inference: record.id,
      observation: await observation(),
      verdict: 'confirmed',
      note: null,
      linkedBy: MODEL_PARTY,
      dataset: 'live',
    });

    const { rows } = await db.app.query('select id from facts.record where id = $1', [
      record.id,
    ]);
    assert.equal(rows.length, 0);
  });

  test('a validation cannot be edited or deleted, including by the owner', async () => {
    const input = await observation();
    const { record } = await inferences.append(prediction({ inputs: [input] }), {
      lawfulBasis: 'consent',
    });
    const link = await inferences.validate({
      inference: record.id,
      observation: await observation(),
      verdict: 'confirmed',
      note: null,
      linkedBy: MODEL_PARTY,
      dataset: 'live',
    });

    await assert.rejects(() =>
      db.owner.query(`update inference.validation set verdict = 'contradicted' where id = $1`, [
        link.id,
      ]),
    );
    await assert.rejects(() =>
      db.owner.query('delete from inference.validation where id = $1', [link.id]),
    );
  });
});

describe('a retracted validator makes the verdict stale, as a retracted input does', () => {
  test('staleness already reads validated_by, and now there is something to read', async () => {
    const input = await observation();
    const { record } = await inferences.append(prediction({ inputs: [input] }), {
      lawfulBasis: 'consent',
    });
    const settled = await observation();
    await inferences.validate({
      inference: record.id,
      observation: settled,
      verdict: 'confirmed',
      note: null,
      linkedBy: MODEL_PARTY,
      dataset: 'live',
    });

    const before = await read.getInference(record.id, { requester: MODEL_PARTY });
    assert.equal(before?.staleness?.stale, false);

    await ingest(retractionDocument(settled, { asserted_by: MODEL_PARTY }), {
      lawfulBasis: 'consent',
    });

    const after = await read.getInference(record.id, { requester: MODEL_PARTY });
    assert.equal(after?.staleness?.stale, true);
    assert.ok(after?.staleness?.retracted_inputs.includes(settled));
  });
});

describe('the training path cannot reach a prediction', () => {
  test('it reads observations through its own role', async () => {
    await observation();
    const training = new TrainingRepository(db.training);
    const rows = await training.observations({ type: 'harvest' });
    assert.ok(rows.length > 0);
  });

  test('naming the inference schema fails on privileges, not on a filter', async () => {
    const error = await db.training
      .query('select count(*) from inference.record')
      .then(() => null)
      .catch((caught: unknown) => caught);

    assert.ok(error !== null);
    assert.equal(sqlState(error), INSUFFICIENT_PRIVILEGE);
  });

  test('the record key table is denied too — it enumerates every inference by id', async () => {
    const error = await db.training
      .query('select count(*) from kernel.record_key')
      .then(() => null)
      .catch((caught: unknown) => caught);

    assert.equal(sqlState(error), INSUFFICIENT_PRIVILEGE);
  });

  test('it cannot write to the fact log either', async () => {
    const error = await db.training
      .query('delete from facts.record')
      .then(() => null)
      .catch((caught: unknown) => caught);

    assert.equal(sqlState(error), INSUFFICIENT_PRIVILEGE);
  });

  test('the training module names no relation outside facts', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        new URL('../../src/training/training.repository.ts', import.meta.url),
        'utf8',
      ),
    );
    // The guard is the grant; this is the reviewable half of it. A query added
    // here that reaches elsewhere would fail at runtime, but failing here says
    // why in one line. Comments are excluded — the file explains at length what
    // it is forbidden from naming, and that explanation is the point.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/u.test(line))
      .join('\n');
    assert.equal(/inference\.record|kernel\.record_key/u.test(code), false);
    assert.ok(/facts\.record/u.test(code));
  });
});
