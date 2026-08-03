import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

import 'reflect-metadata';
import { AppModule } from '../../src/app.module.js';
import { KERNEL_POOL } from '../../src/storage/pool.js';
import { KERNEL_CONFIG } from '../../src/config.js';
import { DEFAULT_MASS_BALANCE_TOLERANCE } from '../../src/records/mass-balance.js';
import { DEFAULT_SUPERSESSION_MAX_DEPTH } from '../../src/records/lineage.js';
import { SUBJECT_HEADER } from '../../src/api/subject.js';
import { DATASET_HEADER } from '../../src/api/dataset.js';
import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import { CONVERSIONS, COOP_A_SAMPLE, EXPECTED_FLAGS } from '../../src/seed/fixtures.js';
import { coopASampleStats, generate, type SeedPlan } from '../../src/seed/generate.js';
import { writePlan, type WriteReport } from '../../src/seed/write.js';
import { lenderView } from '../../src/seed/lender-view.js';

/**
 * Work order D6. The seed asserts itself.
 *
 * A fixture corpus that nobody checks rots into something that no longer
 * contains the cases it was built for, and the day it stops reproducing the
 * conversion bug is the day it stops being worth running. Every number below is
 * a claim about what the corpus contains, and the CI job is what keeps it true.
 */

let db: TestDatabase;
let app: INestApplication;
let base: string;
let plan: SeedPlan;
let report: WriteReport;

before(async () => {
  db = await startTestDatabase();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KERNEL_POOL)
    .useValue(db.app)
    .overrideProvider(KERNEL_CONFIG)
    .useValue({
      MASS_BALANCE_TOLERANCE: DEFAULT_MASS_BALANCE_TOLERANCE,
      SUPERSESSION_MAX_DEPTH: DEFAULT_SUPERSESSION_MAX_DEPTH,
      // The gate D0 put in front of fabricated data. Without this every write
      // below would land in `live`, which is the whole thing it prevents.
      SEED_INGEST_ENABLED: true,
    })
    .compile();

  app = moduleRef.createNestApplication();
  app.useLogger(false);
  await app.listen(0);
  base = await app.getUrl();

  plan = generate();
  report = await writePlan(plan, { baseUrl: base });
});

after(async () => {
  await app.close();
  await db.stop();
});

const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const result = await db.owner.query<{ n: string }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
};

describe('the adversarial seed', () => {
  test('every write lands the way the fixture says it should', () => {
    assert.deepEqual(
      report.surprises.map(
        (s) =>
          `#${s.index} ${s.type} ${s.status} ${s.problem?.detail ?? ''} ${s.note ?? ''}`,
      ),
      [],
    );
    assert.ok(report.rejected >= 3, `expected refusals, got ${report.rejected}`);
  });

  test('nothing reached the live dataset', async () => {
    assert.equal(await count("select count(*) n from facts.record where dataset = 'live'"), 0);
    assert.equal(
      await count("select count(*) n from inference.record where dataset = 'live'"),
      0,
    );
  });

  test('the row count is exactly what the plan asserted', async () => {
    const facts = await count("select count(*) n from facts.record where dataset = 'seed'");
    const inferences = await count(
      "select count(*) n from inference.record where dataset = 'seed'",
    );
    assert.equal(facts + inferences, report.accepted);
    assert.equal(
      facts + inferences,
      plan.writes.filter((w) => w.expect === 'accepted').length,
    );
  });

  test('no inference is in the fact log', async () => {
    assert.equal(
      await count("select count(*) n from facts.record where record_class = 'inference'"),
      0,
    );
    // Zero, and not because the seed omitted one. The plan contains a fully
    // formed Inference; the kernel has no write path for it yet. See the
    // refusal asserted below and the finding in 0023.
    assert.equal(await count('select count(*) n from inference.record'), 0);
  });

  test('an inference cannot be written through the public API at all', () => {
    const refusal = report.outcomes.find((o) => o.type === 'inference');
    assert.ok(refusal, 'the inference case is missing from the plan');
    assert.equal(refusal.expected, 'rejected');
    assert.equal(refusal.status, 422);
    assert.match(String(refusal.problem?.detail), /no entity named "inference"/);
  });

  test('the corpus is the size work order D3 asked for', async () => {
    const deliveries = await count(
      "select count(*) n from facts.record where type = 'delivery'",
    );
    const farmers = plan.farmers.length;
    assert.equal(farmers, 80);
    assert.ok(deliveries >= 200, `expected at least 200 deliveries, got ${deliveries}`);
  });
});

describe('the quality flags the corpus exists to reproduce', () => {
  test('every expected flag has a non-zero count', async () => {
    const tallies = new Map<string, number>();
    for (const flag of EXPECTED_FLAGS) {
      tallies.set(
        flag,
        await count('select count(*) n from facts.record where quality_flags @> $1::text[]', [
          [flag],
        ]),
      );
    }

    const missing = [...tallies.entries()].filter(([, n]) => n === 0).map(([flag]) => flag);
    assert.deepEqual(missing, [], `flags absent from the corpus: ${missing.join(', ')}`);
  });

  test('coop C reproduces the conversion bug and coop D the missing factor', async () => {
    // The two counts work order A's correctness bug depends on. Zero on either
    // means the fixtures drifted and the corpus no longer proves anything.
    const mismatch = await count(
      "select count(*) n from facts.record where quality_flags @> array['conversion_mismatch']",
    );
    const unresolved = await count(
      "select count(*) n from facts.record where quality_flags @> array['conversion_unresolved']",
    );
    assert.ok(mismatch > 0, 'conversion_mismatch is zero — coop C stopped mismatching');
    assert.ok(unresolved > 0, 'conversion_unresolved is zero — coop D found a factor');
  });

  test('a factor cited outside its scope is flagged, not applied', async () => {
    const flags = await db.owner.query<{ quality_flags: string[] }>(
      'select quality_flags from facts.record where id = $1',
      [plan.markers.scopeMismatchDelivery],
    );
    assert.ok(flags.rows[0]?.quality_flags.includes('conversion_scope_mismatch'));
  });

  test('a clock ahead of the server is flagged and kept', async () => {
    const future = await count(
      "select count(*) n from facts.record where quality_flags @> array['occurred_after_recorded']",
    );
    assert.ok(future > 0, 'no future-dated record survived');
    // Kept, not refused. P6: flag, never reject.
    assert.equal(
      await count(
        "select count(*) n from facts.record" +
          " where quality_flags @> array['occurred_after_recorded'] and occurred_at > recorded_at",
      ),
      future,
    );
  });

  test('a mass-balance discrepancy is stored, not refused', async () => {
    const flagged = await count(
      "select count(*) n from facts.record" +
        " where type = 'lot' and quality_flags @> array['mass_balance_discrepancy']",
    );
    assert.ok(flagged >= 2, `expected coops B and C to be short, got ${flagged}`);
  });

  test('a bylaw delegation is distinguishable from a signed one', async () => {
    const bylaw = await count(
      "select count(*) n from facts.record" +
        " where quality_flags @> array['delegated_by_organisational_bylaw']",
    );
    assert.equal(bylaw, 40, 'the forty bylaw-authored records are the whole point of the case');
  });
});

describe('the writes the kernel must refuse', () => {
  test('authority nobody granted is refused twice', () => {
    const refusals = report.outcomes.filter((o) => o.expected === 'rejected');
    const delegation = refusals.filter((o) => o.note?.includes('delegation'));
    assert.equal(delegation.length, 2);
    for (const refusal of delegation) {
      assert.equal(refusal.status, 403, `${refusal.type}: ${refusal.problem?.detail ?? ''}`);
    }
  });

  test('a priced delivery cannot be written under contract performance', () => {
    const refusal = report.outcomes.find((o) => o.note?.includes('s.9(1)'));
    assert.ok(refusal, 'the s.9(1) case is missing from the plan');
    // Forbidden, not malformed: the document is valid and the ground is not
    // one the Act makes available for it.
    assert.equal(refusal.status, 403);
    assert.match(String(refusal.problem?.detail), /s\.9\(1\)/);
  });

  test('a refused write left nothing behind', async () => {
    for (const refusal of report.outcomes.filter((o) => o.expected === 'rejected')) {
      assert.equal(
        await count('select count(*) n from facts.record where id = $1', [refusal.id]),
        0,
      );
    }
  });
});

describe('corrections, forks and retractions', () => {
  test('a superseded delivery is still in the log and marked', async () => {
    const rows = await db.owner.query<{ n: string }>(
      'select count(*) n from facts.record where supersedes = $1',
      [plan.markers.supersededDelivery],
    );
    assert.equal(Number(rows.rows[0]?.n), 1);
  });

  test('the fork is surfaced, not auto-merged', async () => {
    const response = await fetch(`${base}/v1/records/${plan.markers.forkParent}`, {
      headers: {
        [SUBJECT_HEADER]: plan.coopParties.A,
        [DATASET_HEADER]: 'seed',
      },
    });
    assert.equal(response.status, 200);
    const view = (await response.json()) as { superseded_by: string[] };
    assert.equal(view.superseded_by.length, 2);
    assert.deepEqual(
      [...view.superseded_by].sort(),
      [plan.markers.forkLeft, plan.markers.forkRight].sort(),
    );
  });

  test('a forked delivery contributes zero to fulfilment, and says the sum is incomplete', async () => {
    const response = await fetch(
      `${base}/v1/records/${plan.markers.partiallyFulfilledAgreement}`,
      { headers: { [SUBJECT_HEADER]: plan.coopParties.C, [DATASET_HEADER]: 'seed' } },
    );
    assert.equal(response.status, 200);

    // Coop A holds the fork, so read its agreement for the incompleteness.
    const forked = await fetch(`${base}/v1/records/${plan.markers.forkAgreement}`, {
      headers: { [SUBJECT_HEADER]: plan.coopParties.A, [DATASET_HEADER]: 'seed' },
    });
    const view = (await forked.json()) as {
      fulfilment?: { forked: number; incomplete: boolean; delivered_kg: number };
    };
    assert.ok(view.fulfilment, 'no fulfilment derived for the agreement holding the fork');
    // Decision 0021: both tips are excluded from the sum and counted separately.
    assert.equal(view.fulfilment.forked, 2);
    assert.equal(view.fulfilment.incomplete, true);
  });

  test('a retraction hides the record without deleting it', async () => {
    assert.equal(
      await count('select count(*) n from facts.record where id = $1', [
        plan.markers.retractedDelivery,
      ]),
      1,
    );
    const response = await fetch(`${base}/v1/records/${plan.markers.retractedDelivery}`, {
      headers: { [SUBJECT_HEADER]: plan.coopParties.B, [DATASET_HEADER]: 'seed' },
    });
    const view = (await response.json()) as { retracted: boolean };
    assert.equal(view.retracted, true);
  });
});

describe('determinism', () => {
  test('the same seed produces byte-identical documents', () => {
    const a = JSON.stringify(generate(4242).writes);
    const b = JSON.stringify(generate(4242).writes);
    assert.equal(a, b);
  });

  test('a different seed produces a different corpus', () => {
    assert.notEqual(JSON.stringify(generate(1).writes), JSON.stringify(generate(2).writes));
  });
});

describe('the measured conversion', () => {
  test('the summary statistics restate the twelve weights and add nothing', async () => {
    const stats = coopASampleStats();
    const row = await db.owner.query<{
      sample_size: number;
      sample_min: string;
      sample_max: string;
      sample_stddev: string;
      basis: string;
    }>(
      'select sample_size, sample_min, sample_max, sample_stddev, basis' +
        ' from registry.unit_conversion where id = $1',
      [CONVERSIONS.maizeBagMeasured],
    );

    const stored = row.rows[0];
    assert.ok(stored, 'the measured factor is missing from the registry');
    assert.equal(stored.basis, 'measured');
    assert.equal(stored.sample_size, COOP_A_SAMPLE.length);
    assert.equal(Number(stored.sample_min), stats.min);
    assert.equal(Number(stored.sample_max), stats.max);
    // Four decimals: the column is numeric(20,8) and the weights are to 0.1kg.
    assert.equal(Number(stored.sample_stddev).toFixed(4), stats.stddev.toFixed(4));
  });

  test('the weights the seed assumes are the weights on file', async () => {
    // Until migration 0015 the twelve numbers existed only in this fixture and
    // in a prose `source` string. The summary could not be checked against
    // anything, which made "measured" a claim rather than a reference.
    const rows = await db.owner.query<{ ordinal: number; weight_kg: string }>(
      'select ordinal, weight_kg from registry.unit_conversion_sample' +
        ' where conversion = $1 order by ordinal',
      [CONVERSIONS.maizeBagMeasured],
    );

    assert.deepEqual(
      rows.rows.map((row) => Number(row.weight_kg)),
      [...COOP_A_SAMPLE],
    );
  });
});

describe('the lender view', () => {
  test('contrasts a trustworthy record with one that only looks trustworthy', async () => {
    const report = await lenderView(plan, base);
    assert.match(report, /LENDER VIEW/);
    // Both farmers must actually resolve; an empty section would pass a
    // looser assertion while proving nothing.
    assert.match(report, /DELIVERIES[\s\S]*DELIVERIES/);
    assert.match(report, /WHERE THE NUMBERS COME FROM/);
    assert.match(report, /conversion_mismatch/);
  });

  test('the contrast is printed, not left to the reader to look up', async () => {
    const report = await lenderView(plan, base);
    // The whole artifact: one line says somebody weighed twelve bags, the
    // other says a number was assumed. Same factor, different evidence.
    assert.match(report, /measured \(n=12\)/);
    assert.match(report, /assumed_default/);
    assert.match(report, /Calibrated platform scale/);
    assert.match(report, /97\.4, 101\.2/);
  });

  test('a cooperative’s mass balance is not filed under a farmer’s name', async () => {
    const report = await lenderView(plan, base);
    const context = report.indexOf('COOPERATIVE CONTEXT');
    assert.ok(context > 0, 'the mass balance needs a section of its own');

    // Denying a farmer credit for their cooperative's scale drift is exactly
    // the harm a verified-record system is supposed to prevent, so the verdict
    // must not appear inside the block that carries their name.
    assert.ok(
      report.indexOf('BREACHES TOLERANCE') > context,
      'a breach verdict appears above the section that disclaims attribution',
    );
    assert.match(report, /not about any member/);
    assert.doesNotMatch(report, /share attributable|farmer’s share/);
  });

  test('a reader can check the verdict and can read the flags', async () => {
    const report = await lenderView(plan, base);
    // "BREACHES TOLERANCE" without the number it breached is unauditable, and
    // the whole-lot number alone is worse than none: coop C's lot is inside the
    // whole-lot threshold and still breaches, because a single hand-over did.
    // A reader given only the first figure would conclude the report is wrong.
    assert.match(report, /tolerance {6}\d+\.\d% — across the whole lot that is \d/);
    assert.match(report, /hand-overs breached it:/);
    assert.match(report, /out by -?\d+\.\d kg \(\d+\.\d%, over \d+\.\d%\)/);
    assert.match(report, /^as at \d{4}-\d{2}-\d{2} /m);
    assert.match(report, /WHAT THE FLAGS MEAN/);
    for (const flag of new Set(report.match(/conversion_\w+/g) ?? [])) {
      assert.ok(
        report.includes(`  ${flag}\n    `),
        `${flag} appears in the report with no explanation of what it means`,
      );
    }
  });
});
