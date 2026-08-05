import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { loadDotenv } from '../dotenv.js';
import { AnchorRepository, type UnanchoredRecord } from './anchor.repository.js';
import { AnchorService, MAX_BATCH_RECORDS } from './anchor.service.js';

/**
 * The daily job.
 *
 *   tsx src/anchoring/anchor-cli.ts [--date 2026-08-03] [--dry-run]
 *   tsx src/anchoring/anchor-cli.ts --check
 *
 * Defaults to yesterday, because today is not over. Safe to run more than once
 * a day and safe to run late: a day already anchored is a no-op, and a day
 * missed is picked up whenever this next runs.
 *
 * `--check` is the one that catches the failure this job is prone to. It asks
 * whether a fresh root exists, and exits non-zero if not. Run it on its own
 * schedule, from somewhere that is not this job: a check that runs as part of
 * the batch cannot report that the batch stopped running.
 *
 * Wired through the application context rather than by hand, so the job and
 * the server cannot disagree about how anything is configured — including
 * whether there is a publisher at all.
 */

function yesterday(): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

function parse(argv: readonly string[]): {
  date: string;
  dryRun: boolean;
  verify: boolean;
  check: boolean;
} {
  const at = argv.indexOf('--date');
  const date = at === -1 ? yesterday() : (argv[at + 1] ?? yesterday());
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD, not ${date}`);
  }
  return {
    date,
    dryRun: argv.includes('--dry-run'),
    verify: argv.includes('--verify'),
    check: argv.includes('--check'),
  };
}

loadDotenv();
const options = parse(process.argv.slice(2));

const context = await NestFactory.createApplicationContext(AppModule, {
  logger: ['warn', 'error'],
});

try {
  if (options.check) {
    const state = await context.get(AnchorService).freshness();

    process.stdout.write(
      `anchor: configured=${state.configured} ` +
        `last_root=${state.last_published ?? 'none'} ` +
        `age_days=${state.age_days ?? '-'} ` +
        `unanchored_age_days=${state.unanchored_age_days ?? '-'} ` +
        `pending=${state.pending_batches} failed=${state.failed_batches}\n`,
    );

    if (state.stale) {
      process.stderr.write(
        state.last_published === null
          ? 'anchor: STALE — a topic is configured and no root has ever been published. ' +
              'Nothing recorded so far can be proved to predate today.\n'
          : `anchor: STALE — the most recent root is ${state.last_published}, ` +
              `${state.age_days} days old, past the ${state.stale_after_days}-day limit. ` +
              'Anchoring has stopped; records since then have no published commitment.\n',
      );
      process.exitCode = 1;
    }
  } else if (options.verify) {
    // Run by restore.sh. Every published root is recomputed from the leaves
    // that are actually in this database. A root published to a public topic
    // before this restore existed is evidence we could not have manufactured,
    // which is more than a manifest we wrote ourselves can ever be.
    const checked = await context.get(AnchorService).verify();

    if (checked.length === 0) {
      process.stdout.write('anchor: no published roots to verify\n');
    }

    let wrong = 0;
    for (const result of checked) {
      if (result.agrees) {
        process.stdout.write(
          `anchor: ${result.batch_date} ok ${result.published_root} ` +
            `(${result.restored_count} records, ${result.network} ` +
            `${result.topic_id ?? '-'}/${result.sequence_number ?? '-'})\n`,
        );
        continue;
      }
      wrong += 1;
      process.stderr.write(
        `anchor: ${result.batch_date} MISMATCH — published ${result.published_root}, ` +
          `restored ${result.recomputed_root ?? 'nothing'} ` +
          `(${result.restored_count} of ${result.expected_count} records)\n`,
      );
    }

    if (wrong > 0) {
      process.stderr.write(
        `anchor: ${wrong} batch(es) do not reproduce their published root. ` +
          'Records are missing or altered; this restore is not the database that was anchored.\n',
      );
      process.exitCode = 1;
    }
  } else if (options.dryRun) {
    const anchors = context.get(AnchorRepository);
    const pending: UnanchoredRecord[] = await anchors.unanchored(
      options.date,
      MAX_BATCH_RECORDS,
    );
    process.stdout.write(
      `anchor: ${pending.length} record(s) would be anchored for ${options.date}\n`,
    );
  } else {
    const service = context.get(AnchorService);
    const run = await service.run(options.date);

    if (run.batch === null) {
      process.stdout.write(`anchor: nothing to anchor for ${options.date}\n`);
    } else {
      process.stdout.write(
        `anchor: ${options.date} root=${run.batch.merkle_root} ` +
          `records=${run.batch.record_count} state=${run.batch.state}\n`,
      );

      if (run.error !== null) {
        // Not a failure of the job. The records are in a tree with a stored
        // root; only the message did not go out, and the next run sends it.
        process.stderr.write(
          `anchor: not published — ${run.error}. Retry in ` +
            `${service.backoffFor(run.batch.attempts)}s; the batch is kept.\n`,
        );
        process.exitCode = 75;
      }
    }
  }
} finally {
  await context.close();
}
