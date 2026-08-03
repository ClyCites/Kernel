import { generate } from './generate.js';
import { lenderView } from './lender-view.js';
import { DEFAULT_SEED } from './random.js';
import { writePlan } from './write.js';

/**
 * `pnpm seed -- --base-url http://localhost:3000 --seed 20260803`
 *
 * The kernel must already be running with `SEED_INGEST_ENABLED=true`, which the
 * config refuses outright in production. Nothing here can reach the live
 * dataset: the header only ever selects `seed`.
 */

interface Args {
  baseUrl: string;
  seed: number;
  planOnly: boolean;
  quiet: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = {
    baseUrl: process.env['SEED_BASE_URL'] ?? 'http://127.0.0.1:3000',
    seed: DEFAULT_SEED,
    planOnly: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--') {
      continue; // pnpm forwards its own separator through to the script
    } else if (flag === '--seed') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value)) throw new Error('--seed expects a number');
      args.seed = value;
      i += 1;
    } else if (flag === '--base-url') {
      args.baseUrl = argv[i + 1] ?? args.baseUrl;
      i += 1;
    } else if (flag === '--plan-only') {
      args.planOnly = true;
    } else if (flag === '--quiet') {
      args.quiet = true;
    } else {
      throw new Error(`unrecognised argument: ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const plan = generate(args.seed);

  if (args.planOnly) {
    // The determinism check. Same seed in, same bytes out — pipe two runs
    // through `diff` and the claim in D1 is either true or it is not.
    process.stdout.write(JSON.stringify(plan.writes, null, 2));
    return;
  }

  process.stderr.write(`seed ${args.seed}: ${plan.writes.length} writes -> ${args.baseUrl}\n`);

  const report = await writePlan(plan, {
    baseUrl: args.baseUrl,
    onProgress: args.quiet
      ? undefined
      : (done, total) => {
          if (done % 50 === 0 || done === total) {
            process.stderr.write(`  ${done}/${total}\n`);
          }
        },
  });

  process.stderr.write(
    `accepted ${report.accepted}, refused ${report.rejected}, unexpected ${report.surprises.length}\n`,
  );

  for (const surprise of report.surprises) {
    process.stderr.write(
      `  ! #${surprise.index} ${surprise.type} expected ${surprise.expected}, got ${surprise.status}` +
        `${surprise.problem?.detail ? ` — ${surprise.problem.detail}` : ''}\n`,
    );
  }

  process.stdout.write(`${await lenderView(plan, args.baseUrl)}\n`);

  if (report.surprises.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
