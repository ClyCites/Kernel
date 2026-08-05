import { DEFAULT_MASS_BALANCE_TOLERANCE } from './mass-balance.js';

/**
 * What a lender is shown, and in what words.
 *
 * FINDING, fixed here: this judgement previously lived nowhere. The one place
 * it was written down was a seed script, and the artifact a credit officer
 * would actually be handed was a JSON dump carrying party ids, delegation ids
 * and `ext: {}` — none of which a human reader needs and all of which invite
 * being pasted into a spreadsheet as though they meant something.
 *
 * So the rules live here, in the kernel, as a pure renderer:
 *
 *   - plain text, because the reader is a person and not a parser;
 *   - no identifier a human does not need, which in practice means no uuid
 *     appears at all — a lender acts on quantities, dates and flags, and an
 *     identifier's only use to them is as a handle for a dispute, which is a
 *     conversation with us and not a column;
 *   - the tolerance threshold printed, because "discrepancy" without the
 *     number it exceeded is an accusation with no scale;
 *   - a glossary entry for every flag shown, and a refusal to show a flag
 *     without one;
 *   - an "as at" date, because every figure here is a reading taken at a
 *     moment and a correction may already be in the log.
 */

/** One line each, in the words a credit officer would need. */
export const FLAG_GLOSSARY: Record<string, string> = {
  measurement_below_underwritable:
    'the quantity rests on a factor nobody has verified — usable for operations, not for lending against',
  conversion_unresolved:
    'the record cites no conversion, or one the registry does not hold; the kilogram figure cannot be checked at all',
  conversion_mismatch:
    'the stated kilograms do not equal the raw quantity times the cited factor — the two disagree and the record kept both',
  conversion_scope_mismatch:
    'the factor was registered for a different commodity or a different district than the record it is used in — the kilogram figure is derived from the wrong rule',
  region_unresolvable:
    'the factor is specific to a district and the record does not say which district it happened in; whether it applies cannot be determined either way',
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
  confirms_superseded_version:
    'the other side confirmed an earlier version of this delivery; the figure was corrected afterwards and the confirmation does not carry forward to the corrected one',
  confirmed_under_delegation:
    'confirmed by somebody acting for the other side rather than by the other side — weaker evidence, because the point of a confirmation is independence',
  confirmed_by_organisational_bylaw:
    'confirmed by a cooperative officer under the cooperative’s own rules; the cooperative is one of the two parties to this delivery, so this is close to the seller confirming their own record',
};

const RULE = '='.repeat(76);

export interface LenderLine {
  /** A date, not a timestamp. A lender does not need the minute. */
  date: string;
  commodity: string;
  /** As recorded: '40 bags'. Null where nothing was recorded. */
  raw: string | null;
  /** Kilograms, where one could be derived. */
  kg: number | null;
  /** How the kilogram figure was arrived at, in words. */
  basis: string;
  confirmation: string;
  flags: string[];
}

export interface LenderSection {
  /** A name, never a party id. */
  heading: string;
  lines: LenderLine[];
  /** Sentences about the section as a whole. */
  notes: string[];
}

export interface LenderReport {
  title: string;
  /** ISO date. Printed, not implied. */
  asAt: string;
  preamble: string[];
  sections: LenderSection[];
  /** What could not be read, and the report's own reading of why. */
  refused: string[];
  massBalanceTolerance?: number;
}

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length);

/**
 * Every flag shown must have a glossary entry. An unexplained flag on a credit
 * file is worse than no flag: it reads as a mark against the farmer and the
 * reader has no way to weigh it, so this returns a visible placeholder rather
 * than a blank the reader will fill in themselves.
 */
const explain = (flag: string): string =>
  FLAG_GLOSSARY[flag] ??
  'NOT DOCUMENTED — this flag has no agreed meaning yet and should not be weighed against anyone until it does';

export function renderLenderReport(report: LenderReport): string {
  const out: string[] = [];
  const tolerance = report.massBalanceTolerance ?? DEFAULT_MASS_BALANCE_TOLERANCE;
  const shown = new Set<string>();

  out.push(report.title, RULE);
  out.push(`as at ${report.asAt}`);
  out.push('');
  out.push(
    'Every figure below is a reading taken on the date above. Records here are',
    'append-only and are corrected by superseding, so a figure may have been',
    'corrected since. Re-run rather than re-reading a saved copy.',
    '',
  );
  out.push(...report.preamble);
  if (report.preamble.length > 0) out.push('');

  for (const section of report.sections) {
    out.push(RULE, section.heading, RULE);
    out.push(
      `  ${pad('DATE', 12)}${pad('COMMODITY', 14)}${pad('AS RECORDED', 14)}${pad('KG', 10)}CONFIRMED`,
    );
    for (const line of section.lines) {
      out.push(
        `  ${pad(line.date, 12)}${pad(line.commodity, 14)}${pad(line.raw ?? '—', 14)}` +
          `${pad(line.kg === null ? '—' : line.kg.toFixed(1), 10)}${line.confirmation}`,
      );
      out.push(`      basis: ${line.basis}`);
      for (const flag of line.flags) {
        shown.add(flag);
        out.push(`      flag:  ${flag}`);
      }
    }
    if (section.lines.length === 0) {
      out.push('  nothing readable in this section');
    }
    if (section.notes.length > 0) {
      out.push('');
      for (const note of section.notes) out.push(`  ${note}`);
    }
    out.push('');
  }

  out.push(RULE, 'WHAT WAS REFUSED', RULE);
  if (report.refused.length === 0) {
    out.push('  nothing — every read attempted here was permitted');
  } else {
    for (const line of report.refused) out.push(`  ${line}`);
  }
  out.push('');
  out.push(
    '  A refused read returns 404 and names nothing. The kernel will not confirm',
    '  that a record exists to somebody who may not read it. The reasons above',
    '  are this report’s own reading of the grants it holds, not something the',
    '  kernel disclosed.',
    '',
  );

  if (shown.size > 0) {
    out.push(RULE, 'WHAT THE FLAGS MEAN', RULE);
    for (const flag of [...shown].sort()) {
      out.push(`  ${flag}`);
      out.push(`    ${explain(flag)}`);
    }
    out.push('');
    out.push(
      '  A flag is not an accusation. The kernel records what it cannot',
      '  reconcile rather than refusing the record, so the reader decides.',
      '',
    );
  }

  // Printed whether or not a discrepancy appears. A reader who sees no
  // discrepancy should know how large one would have had to be to show up.
  out.push(RULE, 'THRESHOLDS USED', RULE);
  out.push(
    `  mass balance tolerance: ${(tolerance * 100).toFixed(1)}% of intake.`,
    '  A lot whose releases differ from its intake by less than this, after',
    '  declared losses, is not flagged. Losses in drying and handling are real',
    '  and a threshold of zero would flag every honest lot.',
    '',
  );

  out.push(RULE, 'WHAT THIS IS NOT', RULE);
  out.push(
    '  Not a score. Nothing here ranks, rates or grades anybody, and no figure',
    '  below is intended to be combined into one that does.',
    '  Not a complete picture. It shows what subjects permitted this reader to',
    '  see, and the gaps are consent decisions rather than absences of activity.',
    '  Not proof. Records are what parties asserted; the flags mark where those',
    '  assertions could not be reconciled, not where anyone was found dishonest.',
  );

  return out.join('\n');
}
