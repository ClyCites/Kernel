import { DATASET_HEADER } from '../api/dataset.js';
import { SUBJECT_HEADER } from '../api/subject.js';
import type { RecordView } from '../records/read.service.js';
import type { UnitConversionDetail } from '../registry/types.js';
import { COOPS } from './fixtures.js';
import type { SeedPlan } from './generate.js';

/**
 * Work order D7, extended by K. What a lender sees.
 *
 * Two farmers, side by side. One belongs to a cooperative that weighs its bags
 * and confirms its deliveries; the other belongs to one whose bags hold 118kg
 * and whose app has always called them 100. Both look like tidy records. Only
 * one of them is evidence, and since work order K the difference is legible:
 * every quantity now resolves to a factor, and every factor states whether
 * anybody actually weighed anything.
 *
 * Two things this report deliberately does not do.
 *
 * It does not print a score. Section 27 of the Data Protection and Privacy Act
 * is about decisions made about people by machines; a number in this column
 * would be one, whatever we called it.
 *
 * It does not attribute the cooperative's mass balance to the farmer named
 * above it. Coop C's lot is short because the coop's bag factor is wrong, not
 * because any member did anything. A proportional share would be arithmetically
 * defensible and would still cost somebody credit for their neighbour's scale.
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

/** One line each, in the words a credit officer would need. */
const GLOSSARY: Record<string, string> = {
  measurement_below_underwritable:
    'the quantity rests on a factor nobody has verified — usable for operations, not for lending against',
  conversion_unresolved:
    'the record cites no conversion, or one the registry does not hold; the kilogram figure cannot be checked at all',
  conversion_mismatch:
    'the stated kilograms do not equal the raw quantity times the cited factor — the two disagree and the record kept both',
  conversion_scope_mismatch:
    'the factor was registered for a different commodity or a different district than the record it is used in',
  quantity_not_normalized:
    'no kilogram figure was derived; the raw count stands alone',
  occurred_after_recorded:
    'the event is dated later than the moment it was written down — a clock problem, not necessarily a dishonest one',
  mass_balance_discrepancy:
    'a lot released more or less than it took in, beyond the tolerance, after declared losses',
  delegated_authority:
    'somebody other than the subject asserted this, under a recorded delegation',
  delegated_by_organisational_bylaw:
    'asserted by a cooperative officer under the cooperative’s own rules rather than an individual mandate',
};

export async function lenderView(plan: SeedPlan, baseUrl: string): Promise<string> {
  const base = baseUrl.replace(/\/$/, '');
  const lines: string[] = [];
  const seen = new Map<string, UnitConversionDetail | null>();
  const flagsSeen = new Set<string>();
  const context: string[] = [];

  lines.push('LENDER VIEW — seed dataset');
  lines.push('='.repeat(76));
  lines.push(`as at ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`);
  lines.push('');
  lines.push('Read as the cooperative, not the lender. A third party is denied every');
  lines.push('record on this corpus: consent is not implemented, and the kernel says so');
  lines.push('rather than guessing. See docs/decisions/0023.');
  lines.push('');
  lines.push('Every factor cited below is public. GET /v1/registry/conversions/{id} takes');
  lines.push('no credential, so all of this can be checked without asking ClyCites.');
  lines.push('');

  for (const key of ['A', 'C'] as const) {
    const coop = COOPS.find((c) => c.key === key)!;
    const farmerId = key === 'A' ? plan.markers.lenderFarmerA : plan.markers.lenderFarmerC;
    const data = await load(base, plan.coopParties[key], farmerId);
    const conversions = await resolveConversions(base, data.deliveries, seen);

    lines.push(...section(coop.name, coop.key, data, farmerId, conversions, flagsSeen));
    lines.push('');
    context.push(...cooperativeContext(coop.name, coop.key, data, flagsSeen));
    context.push('');
  }

  lines.push('='.repeat(76));
  lines.push('COOPERATIVE CONTEXT');
  lines.push('='.repeat(76));
  lines.push('These findings belong to the cooperative and to no member of it. A lot is');
  lines.push('the pooled output of many farmers; a discrepancy in one cannot be traced to');
  lines.push('any individual delivery and is not evidence about anybody named above. It');
  lines.push('is stated here because it bears on the reliability of the cooperative’s');
  lines.push('measurement, which is a different question from the conduct of a member.');
  lines.push('');
  lines.push(...context);

  const glossary = [...flagsSeen].sort();
  if (glossary.length > 0) {
    lines.push('='.repeat(76));
    lines.push('WHAT THE FLAGS MEAN');
    lines.push('='.repeat(76));
    for (const flag of glossary) {
      lines.push(`  ${flag}`);
      lines.push(`    ${GLOSSARY[flag] ?? 'no description registered for this flag'}`);
    }
    lines.push('');
    lines.push('  A flag is not an accusation. The kernel records what it cannot');
    lines.push('  reconcile rather than refusing the record, so the reader decides.');
    lines.push('');
  }

  lines.push('-'.repeat(76));
  lines.push('The two files are the same shape, and that is the problem a lender had');
  lines.push('until the factors became readable. Both farmers delivered bags. Only one');
  lines.push('cooperative can say what a bag weighs — and that claim, with the twelve');
  lines.push('weighings behind it, can now be pulled up and checked by anyone. Coop C');
  lines.push('cites a factor on every line, the factor is assumed, and it is wrong by');
  lines.push('eighteen percent. Nothing in coop C’s own records reveals that. The');
  lines.push('registry does.');
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
    deliveries: [...(page?.records ?? [])].sort((a, b) =>
      String((b.record as Record<string, unknown>)['occurred_at']).localeCompare(
        String((a.record as Record<string, unknown>)['occurred_at']),
      ),
    ),
    lots: lotPage?.records ?? [],
  };
}

/**
 * No subject header, no dataset header, no credential. That is the point: the
 * registry is the one surface a lender can read on their own account, so the
 * report fetches it the way a lender would.
 */
async function resolveConversions(
  base: string,
  deliveries: RecordView[],
  cache: Map<string, UnitConversionDetail | null>,
): Promise<Map<string, UnitConversionDetail | null>> {
  for (const view of deliveries) {
    const quantity = (view.record as Record<string, unknown>)['quantity'] as
      | Record<string, unknown>
      | undefined;
    const id = String(quantity?.['conversion_id'] ?? '');
    if (id === '' || cache.has(id)) continue;

    const response = await fetch(`${base}/v1/registry/conversions/${id}`);
    cache.set(id, response.ok ? ((await response.json()) as UnitConversionDetail) : null);
  }
  return cache;
}

/** `measured (n=12)` beside `assumed_default`. The contrast is the artifact. */
function describeBasis(conversion: UnitConversionDetail | null | undefined): string {
  if (conversion === null || conversion === undefined) return 'UNRESOLVABLE';
  if (conversion.basis === 'measured' && conversion.sample_size !== null) {
    return `measured (n=${conversion.sample_size})`;
  }
  return conversion.basis;
}

function section(
  coopName: string,
  key: string,
  data: Fetched,
  farmerId: string,
  conversions: Map<string, UnitConversionDetail | null>,
  flagsSeen: Set<string>,
): string[] {
  const lines: string[] = [];
  const body = (data.farmer?.record ?? {}) as Record<string, unknown>;
  const identifiers = (body['identifiers'] as unknown[] | undefined) ?? [];

  lines.push('-'.repeat(76));
  lines.push(`${String(body['display_name'] ?? '(unreadable)')}  —  ${coopName} [${key}]`);
  lines.push('-'.repeat(76));
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
  let verifiedKg = 0;
  let confirmed = 0;
  const flags = new Map<string, number>();
  const cited = new Set<string>();

  lines.push('  DELIVERIES');
  for (const view of data.deliveries) {
    const record = view.record as Record<string, unknown>;
    const quantity = record['quantity'] as Record<string, unknown>;
    const kg =
      typeof quantity['normalized_kg'] === 'number' ? quantity['normalized_kg'] : null;
    const id = String(quantity['conversion_id'] ?? '');
    const conversion = id === '' ? null : conversions.get(id);
    if (kg !== null) totalKg += kg;
    if (kg !== null && conversion?.basis === 'measured') verifiedKg += kg;
    const isConfirmed = record['counterparty_confirmed_at'] !== null;
    if (isConfirmed) confirmed += 1;
    for (const flag of view.quality_flags) {
      flags.set(flag, (flags.get(flag) ?? 0) + 1);
      flagsSeen.add(flag);
    }
    if (id !== '') cited.add(id);

    lines.push(
      `    ${String(record['occurred_at']).slice(0, 10)}  ` +
        `${String(quantity['raw_value']).padStart(4)} ${String(quantity['raw_unit']).padEnd(5)}` +
        `-> ${(kg === null ? 'NOT NORMALISED' : `${kg.toFixed(1)} kg`).padStart(13)}` +
        `   ${describeBasis(conversion).padEnd(18)}` +
        `${String(quantity['measurement_method'] ?? 'unstated').padEnd(20)}` +
        `${isConfirmed ? 'confirmed' : 'unconfirmed'}` +
        (view.quality_flags.length > 0 ? `  [${view.quality_flags.join(', ')}]` : ''),
    );
  }

  lines.push('');
  lines.push(`  total normalised    ${totalKg.toFixed(1)} kg`);
  lines.push(
    `  on measured factors ${verifiedKg.toFixed(1)} kg` +
      ` (${totalKg === 0 ? '0' : ((verifiedKg / totalKg) * 100).toFixed(0)}%)`,
  );
  lines.push(
    `  two-sided           ${confirmed}/${data.deliveries.length} confirmed by the farmer`,
  );

  lines.push('');
  lines.push('  WHERE THE NUMBERS COME FROM');
  for (const id of [...cited].sort()) {
    lines.push(...provenance(id, conversions.get(id)));
  }

  lines.push('');
  lines.push(
    flags.size === 0
      ? '  no quality flags raised on any delivery'
      : [...flags.entries()]
          .sort()
          .map(([flag, count]) => `  ${flag}: ${count}`)
          .join('\n'),
  );

  return lines;
}

function provenance(
  id: string,
  conversion: UnitConversionDetail | null | undefined,
): string[] {
  if (conversion === null || conversion === undefined) {
    return [`    ${id}`, '      not in the registry — this quantity cannot be checked'];
  }

  const lines: string[] = [];
  lines.push(
    `    ${id}   ${conversion.from_unit} -> ${conversion.to_unit}` +
      ` x ${Number(conversion.factor)}` +
      (conversion.local_label === null ? '' : `  ("${conversion.local_label}")`),
  );
  lines.push(
    `      basis         ${describeBasis(conversion)}` +
      (conversion.commodity === null ? '' : `, for ${conversion.commodity}`) +
      (conversion.region_code === null
        ? ''
        : `, in ${conversion.region_code}@${conversion.region_vintage} only`),
  );

  if (conversion.sample.length === 0) {
    lines.push(`      evidence      none on file. ${conversion.source ?? 'No source recorded.'}`);
    lines.push('      A convention, not a measurement. Nobody has weighed it.');
    return lines;
  }

  const weights = conversion.sample.map((s) => s.weight_kg);
  lines.push(
    `      weighed by    ${conversion.measured_by ?? 'unrecorded'}` +
      (conversion.measured_at === null ? '' : ` on ${conversion.measured_at.slice(0, 10)}`),
  );
  lines.push(`      instrument    ${conversion.instrument ?? 'unrecorded'}`);
  lines.push(`      sample        ${weights.join(', ')} kg`);
  lines.push(
    `      spread        ${Math.min(...weights)} – ${Math.max(...weights)} kg` +
      (conversion.sample_stddev === null
        ? ''
        : `, sd ${Number(conversion.sample_stddev).toFixed(2)}`),
  );

  const damp = conversion.sample.filter((s) => s.condition !== 'dried,tight');
  if (damp.length > 0) {
    lines.push(
      `      note          ${damp.length} of ${conversion.sample.length} were weighed damp,` +
        ' which is where the spread comes from',
    );
  }
  return lines;
}

function cooperativeContext(
  coopName: string,
  key: string,
  data: Fetched,
  flagsSeen: Set<string>,
): string[] {
  const lines: string[] = [];
  const lot = data.lots[0];

  lines.push('-'.repeat(76));
  lines.push(`${coopName} [${key}] — mass balance on the lot its members fed`);
  lines.push('-'.repeat(76));

  if (!lot?.balance) {
    lines.push('  no lot readable');
    return lines;
  }

  const balance = lot.balance;
  const opening = balance.opening_kg;
  const unexplained = balance.unexplained_kg;
  const pct = (balance.tolerance * 100).toFixed(1);
  const breachingLegs = balance.legs.filter((leg) => leg.breached);

  lines.push(`    lot            ${String((lot.record as Record<string, unknown>)['id'])}`);
  lines.push(`    opening        ${opening?.toFixed(1) ?? 'unknown'} kg`);
  lines.push(`    closing        ${balance.closing_kg?.toFixed(1) ?? 'unknown'} kg`);
  lines.push(`    declared loss  ${balance.declared_loss_kg.toFixed(1)} kg`);
  lines.push(`    unexplained    ${unexplained?.toFixed(1) ?? 'unknown'} kg`);
  lines.push(
    `    tolerance      ${pct}%` +
      (opening === null || opening === undefined
        ? ''
        : ` — across the whole lot that is ${(opening * balance.tolerance).toFixed(1)} kg,` +
          ` and this lot is out by ${Math.abs(unexplained ?? 0).toFixed(1)} kg`),
  );
  lines.push(
    `    verdict        ${balance.breached ? 'BREACHES TOLERANCE' : 'within tolerance'}` +
      `${balance.incomplete ? ' (and the ledger is incomplete)' : ''}`,
  );

  if (breachingLegs.length > 0) {
    // Without this the reader checks the whole-lot figure against the whole-lot
    // threshold, finds it inside, and concludes the report is wrong. The
    // tolerance applies to each hand-over as well, and a lot can pass overall
    // while one hand-over inside it does not.
    lines.push('');
    lines.push(
      `    The tolerance is applied to each hand-over as well as to the lot.` +
        ` ${breachingLegs.length} of ${balance.legs.length} hand-overs breached it:`,
    );
    for (const leg of breachingLegs) {
      const expected = leg.expected_kg;
      const share =
        expected === null || expected === 0 || leg.discrepancy_kg === null
          ? null
          : (Math.abs(leg.discrepancy_kg) / expected) * 100;
      lines.push(
        `      ${leg.at.slice(0, 10)}  expected ${expected?.toFixed(1) ?? 'unknown'} kg,` +
          ` weighed ${leg.weighed_kg?.toFixed(1) ?? 'unknown'} kg,` +
          ` out by ${leg.discrepancy_kg?.toFixed(1) ?? 'unknown'} kg` +
          (share === null ? '' : ` (${share.toFixed(1)}%, over ${pct}%)`),
      );
    }
  }

  if (balance.breached) {
    flagsSeen.add('mass_balance_discrepancy');
    lines.push('');
    lines.push('    A finding about the cooperative’s measurement, not about any member.');
    lines.push('    Mass appearing in a lot is what a bag factor set too low looks like:');
    lines.push('    every delivery is recorded lighter than it was, and the surplus shows');
    lines.push('    up when the lot is weighed whole. No individual delivery is implicated');
    lines.push('    and no share of this is attributed to one.');
  }

  return lines;
}
