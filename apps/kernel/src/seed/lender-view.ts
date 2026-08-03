import { DATASET_HEADER } from '../api/dataset.js';
import { SUBJECT_HEADER } from '../api/subject.js';
import type { RecordView } from '../records/read.service.js';
import { COOPS } from './fixtures.js';
import type { SeedPlan } from './generate.js';

/**
 * Work order D7. What a lender sees.
 *
 * Two farmers, side by side. One belongs to a cooperative that weighs its bags
 * and confirms its deliveries; the other belongs to one whose bags hold 118kg
 * and whose app has always called them 100. Both look like tidy records. Only
 * one of them is evidence.
 *
 * FINDING: this cannot be run *as* the lender. `ConsentService.decide` allows a
 * self read or an asserter read and nothing else, so a third party gets
 * `consent_not_implemented` on every record. The report below is therefore
 * produced by the cooperative — which is the honest position today, and the
 * deny-all guard working as designed rather than a gap in the seed.
 */

interface Fetched {
  farmer: RecordView | null;
  deliveries: RecordView[];
  lots: RecordView[];
}

export async function lenderView(plan: SeedPlan, baseUrl: string): Promise<string> {
  const base = baseUrl.replace(/\/$/, '');
  const lines: string[] = [];

  lines.push('LENDER VIEW — seed dataset');
  lines.push('='.repeat(72));
  lines.push('');
  lines.push('Read as the cooperative, not the lender. A third party is denied every');
  lines.push('record on this corpus: consent is not implemented, and the kernel says so');
  lines.push('rather than guessing. See docs/decisions/0023.');
  lines.push('');

  for (const key of ['A', 'C'] as const) {
    const coop = COOPS.find((c) => c.key === key)!;
    const farmerId = key === 'A' ? plan.markers.lenderFarmerA : plan.markers.lenderFarmerC;
    const data = await load(base, plan.coopParties[key], farmerId);
    lines.push(...section(coop.name, coop.key, data, farmerId));
    lines.push('');
  }

  lines.push('-'.repeat(72));
  lines.push('The two files are the same shape. The difference is that one of them');
  lines.push('states, on every quantity, which weighing it came from — and the other');
  lines.push('states that nobody knows.');
  return lines.join('\n');
}

async function load(base: string, reader: string, farmerId: string): Promise<Fetched> {
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, {
      headers: { [SUBJECT_HEADER]: reader, [DATASET_HEADER]: 'seed' },
    });
    if (!response.ok) return null;
    return response.json();
  };

  const farmer = (await get(`/v1/records/${farmerId}`)) as RecordView | null;
  const page = (await get(`/v1/records?subject=${farmerId}&type=delivery&limit=100`)) as
    | { records: RecordView[] }
    | null;
  const lotPage = (await get(`/v1/records?asserted_by=${reader}&type=lot&limit=10`)) as
    | { records: RecordView[] }
    | null;

  return {
    farmer,
    deliveries: page?.records ?? [],
    lots: lotPage?.records ?? [],
  };
}

function section(
  coopName: string,
  key: string,
  data: Fetched,
  farmerId: string,
): string[] {
  const lines: string[] = [];
  const body = (data.farmer?.record ?? {}) as Record<string, unknown>;
  const identifiers = (body['identifiers'] as unknown[] | undefined) ?? [];

  lines.push('-'.repeat(72));
  lines.push(`${String(body['display_name'] ?? '(unreadable)')}  —  ${coopName} [${key}]`);
  lines.push('-'.repeat(72));
  lines.push(`  party            ${farmerId}`);
  lines.push(
    `  identity         ${identifiers.length > 0 ? 'national ID attested by the cooperative' : 'none on file'}`,
  );
  lines.push('');

  if (data.deliveries.length === 0) {
    lines.push('  no deliveries readable');
    return lines;
  }

  let totalKg = 0;
  let confirmed = 0;
  const flags = new Map<string, number>();

  lines.push('  DELIVERIES');
  for (const view of data.deliveries) {
    const record = view.record as Record<string, unknown>;
    const quantity = record['quantity'] as Record<string, unknown>;
    const kg = typeof quantity['normalized_kg'] === 'number' ? quantity['normalized_kg'] : null;
    if (kg !== null) totalKg += kg;
    const isConfirmed = record['counterparty_confirmed_at'] !== null;
    if (isConfirmed) confirmed += 1;
    for (const flag of view.quality_flags) flags.set(flag, (flags.get(flag) ?? 0) + 1);

    lines.push(
      `    ${String(record['occurred_at']).slice(0, 10)}  ` +
        `${String(quantity['raw_value']).padStart(4)} ${String(quantity['raw_unit'])}` +
        ` -> ${kg === null ? 'NOT NORMALISED' : `${kg.toFixed(1)} kg`}` +
        `  ${isConfirmed ? 'confirmed' : 'unconfirmed'}` +
        (view.quality_flags.length > 0 ? `  [${view.quality_flags.join(', ')}]` : ''),
    );
  }

  lines.push('');
  lines.push(`  total normalised    ${totalKg.toFixed(1)} kg`);
  lines.push(
    `  two-sided           ${confirmed}/${data.deliveries.length} confirmed by the farmer`,
  );

  lines.push('');
  lines.push('  WHERE THE NUMBERS COME FROM');
  lines.push(
    flags.size === 0
      ? '    no quality flags raised on any delivery'
      : [...flags.entries()]
          .sort()
          .map(([flag, count]) => `    ${flag}: ${count}`)
          .join('\n'),
  );

  const lot = data.lots[0];
  if (lot?.balance) {
    const balance = lot.balance;
    lines.push('');
    lines.push('  MASS BALANCE ON THE COOPERATIVE LOT THIS FARMER FED');
    lines.push(`    opening        ${balance.opening_kg?.toFixed(1) ?? 'unknown'} kg`);
    lines.push(`    closing        ${balance.closing_kg?.toFixed(1) ?? 'unknown'} kg`);
    lines.push(`    declared loss  ${balance.declared_loss_kg.toFixed(1)} kg`);
    lines.push(`    unexplained    ${balance.unexplained_kg?.toFixed(1) ?? 'unknown'} kg`);
    lines.push(
      `    verdict        ${balance.breached ? 'BREACHES TOLERANCE' : 'within tolerance'}` +
        `${balance.incomplete ? ' (and the ledger is incomplete)' : ''}`,
    );
  }

  return lines;
}
