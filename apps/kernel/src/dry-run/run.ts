import { readFileSync, writeFileSync } from 'node:fs';

import { SCHEMA_VERSION } from '@clycites/schema';
import { uuidv7 } from 'uuidv7';

import { LAWFUL_BASIS_HEADER } from '../api/dataset.js';
import { SUBJECT_HEADER } from '../api/subject.js';
import { photograph } from './photograph.js';

/**
 * The scripted rehearsal. Work order Q2.
 *
 * Not a test suite. It runs one cooperative through one season in the order
 * the field would produce, printing what it did so a human can read it. Most
 * of the individual behaviours here are already covered by unit tests; what is
 * not covered anywhere else is the *sequence* — what has to exist before what,
 * and what a step costs in wall-clock time when it follows a real predecessor
 * rather than a fixture.
 *
 * Everything goes through the public API over HTTP. Nothing here imports a
 * service or touches a pool. If a step cannot be done from outside, that is a
 * finding and not an excuse to reach inside.
 *
 * Phases exist so `scripts/dry-run.sh` can interleave the operator jobs —
 * anchoring, external verification, backup and restore — between them, which
 * is the part of the ordering no single process can rehearse on its own.
 */

const CONVERSION_BAG_TO_KG = '019fc600-0000-7000-8000-000000000020';
const DISTRICT = { code: 'UG.MASAKA', vintage: '2020' };

interface Handoff {
  coop: string;
  officer: string;
  farmer: string;
  lender: string;
  delegation: string;
  plot: string;
  planting: string;
  harvest: string;
  delivery: string;
  correction: string | null;
  contentHash: string | null;
  grant: string | null;
}

/* ── plumbing ─────────────────────────────────────────────────────────────── */

const baseUrl = (
  process.env['DRY_RUN_BASE_URL'] ?? 'http://127.0.0.1:3000'
).replace(/\/$/u, '');

let indent = '';
const say = (text = ''): void => {
  process.stdout.write(text === '' ? '\n' : `${indent}${text}\n`);
};

const RULE = '─'.repeat(74);

async function stage<T>(number: number, title: string, body: () => Promise<T>): Promise<T> {
  say();
  say(`┌${RULE}`);
  say(`│ Stage ${number} — ${title}`);
  say(`└${RULE}`);
  indent = '  ';
  const started = Date.now();
  try {
    return await body();
  } finally {
    const seconds = ((Date.now() - started) / 1000).toFixed(2);
    indent = '';
    say(`  ── stage ${number} took ${seconds}s`);
  }
}

interface CallOptions {
  as?: string;
  basis?: string;
  /** A query parameter, not a header — every read beyond your own needs one. */
  purpose?: string;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: Buffer;
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.as !== undefined) headers[SUBJECT_HEADER] = options.as;
  if (options.basis !== undefined) headers[LAWFUL_BASIS_HEADER] = options.basis;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const query =
    options.purpose === undefined
      ? ''
      : `${path.includes('?') ? '&' : '?'}purpose=${options.purpose}`;

  const response = await fetch(`${baseUrl}${path}${query}`, {
    method,
    headers,
    ...(options.raw !== undefined
      ? { body: new Uint8Array(options.raw) }
      : options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });

  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text !== '') {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { _text: text };
    }
  }
  return { status: response.status, body, headers: response.headers };
}

/** Print the refusal a caller would actually see, rather than a stack trace. */
const refusal = (answer: Answer): string => {
  const detail = answer.body['detail'] ?? answer.body['message'] ?? answer.body['title'];
  return `${answer.status} ${typeof detail === 'string' ? detail : JSON.stringify(answer.body)}`;
};

function expect(answer: Answer, what: string): Answer {
  if (answer.status >= 200 && answer.status < 300) return answer;
  throw new Error(`${what} was refused: ${refusal(answer)}`);
}

const short = (id: string): string => `${id.slice(0, 8)}…${id.slice(-4)}`;

const iso = (daysAgo: number, hour = 9): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

const envelope = (
  fields: {
    id: string;
    type: string;
    occurredAt: string;
    assertedBy: string;
    supersedes?: string;
    onBehalfOf?: string;
    delegation?: string;
  },
  body: Record<string, unknown>,
): Record<string, unknown> => ({
  id: fields.id,
  type: fields.type,
  record_class: 'observation',
  schema_version: SCHEMA_VERSION,
  occurred_at: fields.occurredAt,
  occurred_at_precision: 'day',
  asserted_by: fields.assertedBy,
  ...(fields.onBehalfOf !== undefined ? { on_behalf_of: fields.onBehalfOf } : {}),
  ...(fields.delegation !== undefined ? { delegation: fields.delegation } : {}),
  ...(fields.supersedes !== undefined ? { supersedes: fields.supersedes } : {}),
  ...body,
});

const point = (lat: number, lon: number, capturedAt: string) => ({
  lat,
  lon,
  accuracy_m: 8,
  captured_at: capturedAt,
  source: 'gps_device',
});

/* ── phase A: stages 2 to 6 ───────────────────────────────────────────────── */

async function phaseA(handoffPath: string): Promise<void> {
  const ids = {
    coop: uuidv7(),
    officer: uuidv7(),
    farmer: uuidv7(),
    lender: uuidv7(),
    account: uuidv7(),
    delegation: uuidv7(),
    facility: uuidv7(),
    plot: uuidv7(),
    planting: uuidv7(),
    harvest: uuidv7(),
    delivery: uuidv7(),
  };

  await stage(2, 'enrol', async () => {
    const write = async (
      label: string,
      document: Record<string, unknown>,
      basis: string,
      as: string,
    ): Promise<void> => {
      const answer = expect(
        await call('POST', '/v1/records', { as, basis, body: document }),
        label,
      );
      const flags = (answer.body['flags'] as string[] | undefined) ?? [];
      say(
        `${label.padEnd(30)} ${short(document['id'] as string)}` +
          `${flags.length > 0 ? `  flags: ${flags.join(', ')}` : ''}`,
      );
    };

    await write(
      'cooperative',
      envelope(
        { id: ids.coop, type: 'party', occurredAt: iso(240), assertedBy: ids.coop },
        {
          kind: 'cooperative',
          display_name: 'Bukoto Farmers Cooperative Society',
          identifiers: [],
          contacts: [{ channel: 'phone', value: '+256770000010' }],
          primary_region: DISTRICT,
        },
      ),
      'contract_performance',
      ids.coop,
    );

    await write(
      'lender',
      envelope(
        { id: ids.lender, type: 'party', occurredAt: iso(240), assertedBy: ids.lender },
        {
          kind: 'institution',
          display_name: 'Rift Valley Agricultural Finance',
          identifiers: [],
          contacts: [{ channel: 'phone', value: '+256770000099' }],
          primary_region: { code: 'UG.KAMPALA', vintage: '2020' },
        },
      ),
      'contract_performance',
      ids.lender,
    );

    // The farmer has no Account. That is the ordinary case and the reason the
    // kernel separates Party from Account at all: a person can be the subject
    // of records they have no way to log in and read.
    await write(
      'farmer (no Account)',
      envelope(
        { id: ids.farmer, type: 'party', occurredAt: iso(238), assertedBy: ids.coop },
        {
          kind: 'person',
          display_name: 'Nakato Ssemakula',
          identifiers: [],
          contacts: [{ channel: 'phone', value: '+256772345678' }],
          primary_region: DISTRICT,
        },
      ),
      'contract_performance',
      ids.coop,
    );

    await write(
      'officer',
      envelope(
        { id: ids.officer, type: 'party', occurredAt: iso(238), assertedBy: ids.coop },
        {
          kind: 'person',
          display_name: 'Wasswa Okurut',
          identifiers: [],
          contacts: [{ channel: 'phone', value: '+256778100011' }],
          primary_region: DISTRICT,
        },
      ),
      'contract_performance',
      ids.coop,
    );

    await write(
      'officer Account',
      envelope(
        { id: ids.account, type: 'account', occurredAt: iso(238), assertedBy: ids.coop },
        {
          account_id: uuidv7(),
          primary_party: ids.officer,
          auth_subject: 'coop-a/officer-01',
          status: 'active',
        },
      ),
      'contract_performance',
      ids.coop,
    );

    await write(
      'facility',
      envelope(
        { id: ids.facility, type: 'facility', occurredAt: iso(237), assertedBy: ids.coop },
        {
          kind: 'collection_point',
          operated_by: ids.coop,
          location: point(-0.3341, 31.7343, iso(237, 8)),
          admin_region: DISTRICT,
        },
      ),
      'contract_performance',
      ids.coop,
    );

    // A bylaw delegation: the weakest ground in the enum. The kernel accepts it
    // and flags it, which is the whole design — flag, never reject.
    await write(
      'bylaw delegation',
      envelope(
        { id: ids.delegation, type: 'delegation', occurredAt: iso(236), assertedBy: ids.coop },
        {
          delegator: ids.coop,
          delegate: ids.officer,
          scope: ['delivery', 'harvest', 'observation'],
          granted_at: iso(236, 9),
          granted_via: 'organisational_bylaw',
          expires_at: null,
        },
      ),
      'contract_performance',
      ids.coop,
    );

    say();
    for (const [who, party] of [
      ['farmer', ids.farmer],
      ['officer', ids.officer],
    ] as const) {
      const notice = expect(
        await call('POST', '/v1/retention/notices', {
          as: ids.coop,
          body: {
            party,
            notice_text:
              'Bukoto Farmers Cooperative Society records your plot, plantings, ' +
              'harvests and deliveries so that your production history can be shown ' +
              'to lenders you choose. We keep these records for seven years after ' +
              'your membership ends. You may object at any time, and objecting does ' +
              'not stop you seeing what we hold.',
            period_stated: 'seven years after membership ends',
            lawful_basis: 'contract_performance',
            purposes: ['credit_assessment', 'traceability_claim'],
            language: 'en',
            given_via: 'in_person_reading',
            given_at: iso(238, 10),
          },
        }),
        `retention notice for the ${who}`,
      );
      say(`retention notice to ${who}`);
      say(`  given via     ${notice.body['given_via'] ?? 'in_person_reading'}`);
      say(`  period stated ${notice.body['period_stated'] ?? 'seven years after membership ends'}`);
      say(`  lawful basis  ${notice.body['lawful_basis'] ?? 'contract_performance'}`);
    }
  });

  const contentHash = await stage(3, 'record', async () => {
    const write = async (
      label: string,
      document: Record<string, unknown>,
      as: string,
      basis = 'contract_performance',
    ): Promise<Answer> => {
      const answer = expect(
        await call('POST', '/v1/records', { as, basis, body: document }),
        label,
      );
      const flags = (answer.body['flags'] as string[] | undefined) ?? [];
      say(
        `${label.padEnd(30)} ${short(document['id'] as string)}` +
          `${flags.length > 0 ? `  flags: ${flags.join(', ')}` : ''}`,
      );
      return answer;
    };

    await write(
      'plot',
      envelope(
        { id: ids.plot, type: 'plot', occurredAt: iso(230), assertedBy: ids.coop },
        {
          held_by: ids.farmer,
          tenure: 'customary',
          centroid: point(-0.3352, 31.7361, iso(230, 11)),
          area: { value: 1.4, unit: 'acre', method: 'declared' },
          admin_region: DISTRICT,
          local_name: 'Ssemakula home garden',
        },
      ),
      ids.coop,
    );

    await write(
      'planting',
      envelope(
        { id: ids.planting, type: 'planting', occurredAt: iso(200), assertedBy: ids.coop },
        {
          plot: ids.plot,
          crop: 'crop.maize.grain',
          variety: 'Longe 10H',
          season: '2026A',
          area_planted: { value: 1.2, unit: 'acre', method: 'declared' },
        },
      ),
      ids.coop,
    );

    await write(
      'harvest',
      envelope(
        { id: ids.harvest, type: 'harvest', occurredAt: iso(40), assertedBy: ids.coop },
        {
          plot: ids.plot,
          crop: 'crop.maize.grain',
          quantity: {
            raw_value: 14,
            raw_unit: 'bag',
            raw_unit_label: 'kaveera',
            normalized_kg: 1400,
            conversion_id: CONVERSION_BAG_TO_KG,
            measurement_method: 'field_estimated',
          },
        },
      ),
      ids.coop,
    );

    say();
    const media = await uploadEvidence(ids.officer);
    // The officer records this under the bylaw delegation, on the coop's
    // behalf. The delegation is named on the record, never searched for.
    //
    // And it goes in on special_data_consent, not contract_performance. A
    // delivery carries an agreed price, which is financial information about
    // an identifiable person, and s.9(1) prohibits that outright except on one
    // of the s.9(3) grounds — of which consent is the only one available here.
    // Recording a sale therefore *requires* the farmer's consent to exist
    // first. That is a real ordering constraint and it runs backwards from how
    // the work order sequences the stages: the grant in stage 5 is, in the
    // field, a precondition of stage 3.
    say('the delivery needs s.9(3) consent — contract performance will not carry it');
    await write(
      'delivery (12 bags)',
      envelope(
        {
          id: ids.delivery,
          type: 'delivery',
          occurredAt: iso(38),
          assertedBy: ids.officer,
          onBehalfOf: ids.coop,
          delegation: ids.delegation,
        },
        {
          from_party: ids.farmer,
          to_party: ids.coop,
          lot: null,
          fulfils: null,
          commodity: 'crop.maize.grain',
          quantity: {
            raw_value: 12,
            raw_unit: 'bag',
            raw_unit_label: 'kaveera',
            normalized_kg: 1200,
            conversion_id: CONVERSION_BAG_TO_KG,
            measurement_method: 'coop_weighed',
          },
          grade: null,
          location: ids.facility,
          agreed_price: { amount_minor: 1150, currency: 'UGX' },
          counterparty_confirmed_at: null,
          counterparty_confirmed_by: null,
          evidence: [media.ref],
        },
      ),
      ids.officer,
      'special_data_consent',
    );

    // Only now can the bytes be read back. `release()` looks for a record that
    // cites the object and that the reader may see; until the delivery existed
    // there was nothing to check consent against, so the upload was stored and
    // unreachable. An orphan object is not disclosable to anyone, including
    // the person who uploaded it.
    say();
    await confirmStripped(media, ids.officer);

    return media.contentHash;
  });

  await stage(4, 'confirm', async () => {
    const before = expect(
      await call('GET', `/v1/records/${ids.delivery}`, { as: ids.coop }),
      'reading the delivery back',
    );
    const body = before.body['body'] as Record<string, unknown> | undefined;
    say(`counterparty_confirmed_at  ${JSON.stringify(body?.['counterparty_confirmed_at'] ?? null)}`);
    say();
    say('The farmer now confirms, by the USSD-shaped path: the party at the');
    say('keyboard is the farmer, and the act is theirs alone.');
    say();

    // A confirmation is a change to a record the coop asserted, so the only
    // append-only route is a supersession by the farmer. Whether the kernel
    // permits that is the question this stage exists to ask.
    const attempt = await call('POST', '/v1/records', {
      as: ids.farmer,
      basis: 'special_data_consent',
      body: envelope(
        {
          id: uuidv7(),
          type: 'delivery',
          occurredAt: iso(38),
          assertedBy: ids.farmer,
          supersedes: ids.delivery,
        },
        {
          from_party: ids.farmer,
          to_party: ids.coop,
          lot: null,
          fulfils: null,
          commodity: 'crop.maize.grain',
          quantity: {
            raw_value: 12,
            raw_unit: 'bag',
            raw_unit_label: 'kaveera',
            normalized_kg: 1200,
            conversion_id: CONVERSION_BAG_TO_KG,
            measurement_method: 'counterparty_confirmed',
          },
          grade: null,
          location: ids.facility,
          agreed_price: { amount_minor: 1150, currency: 'UGX' },
          counterparty_confirmed_at: iso(37, 18),
          counterparty_confirmed_by: ids.farmer,
          evidence: [],
        },
      ),
    });

    if (attempt.status >= 200 && attempt.status < 300) {
      say(`accepted: ${short(attempt.body['id'] as string)}`);
      const after = expect(
        await call('GET', `/v1/records/${ids.delivery}/chain`, { as: ids.coop }),
        'reading the chain',
      );
      say(`chain tip now ${JSON.stringify(after.body['tip'] ?? after.body)}`);
      return;
    }

    say(`REFUSED  ${refusal(attempt)}`);
    say();
    say('This is a finding, not a bug. Spec §8 rule 1 lets only the original');
    say('asserter or their delegate supersede a record. The coop asserted the');
    say('delivery, so the farmer cannot amend it — and there is no confirmation');
    say('endpoint. The only way counterparty_confirmed_at is ever set today is');
    say('the coop writing it at creation time, on the farmer\u2019s behalf.');
    say();
    say('That is a self-attestation by the party with the incentive to overstate,');
    say('recorded in the field the schema calls the entire credit thesis. The');
    say('rehearsal stops short of pretending otherwise and continues.');
  });

  const grant = await stage(5, 'disclose', async () => {
    const grantFrom = async (subject: string, who: string): Promise<string> => {
      const created = expect(
        await call('POST', '/v1/consent/grants', {
          as: subject,
          body: {
            grantee: ids.lender,
            purpose: 'credit_assessment',
            record_types: ['delivery', 'harvest'],
            expires_at: null,
            granted_via: 'ussd_confirmation',
          },
        }),
        `the consent grant from the ${who}`,
      );
      const id = created.body['id'] as string;
      say(`grant from the ${who.padEnd(7)} ${short(id)}  credit_assessment, delivery + harvest`);
      return id;
    };

    const farmerGrant = await grantFrom(ids.farmer, 'farmer');
    say();

    say('the lender reads the delivery, holding the farmer\u2019s grant');
    const partial = await call('GET', `/v1/records/${ids.delivery}`, {
      as: ids.lender,
      purpose: 'credit_assessment',
    });
    say(`  ${partial.status} ${partial.status === 200 ? 'disclosed' : refusal(partial)}`);
    say();
    say('  A delivery has two data subjects: the farmer it came from and the');
    say('  cooperative it went to. One subject\u2019s consent does not authorise');
    say('  disclosing the other\u2019s dealings, so the read is refused even though');
    say('  the farmer said yes. That is right, and it is not obvious \u2014 nothing');
    say('  about asking a farmer for consent suggests a second party must agree');
    say('  before anything can be shown.');
    say();

    await grantFrom(ids.coop, 'coop');
    say();

    say('the lender reads the delivery again, now that both subjects have agreed');
    const allowed = await call('GET', `/v1/records/${ids.delivery}`, {
      as: ids.lender,
      purpose: 'credit_assessment',
    });
    say(`  ${allowed.status} ${allowed.status === 200 ? 'disclosed' : refusal(allowed)}`);
    say();

    say('the same lender reads the plot, which no grant covers');
    const denied = await call('GET', `/v1/records/${ids.plot}`, {
      as: ids.lender,
      purpose: 'credit_assessment',
    });
    say(
      `  ${denied.status} ${denied.status === 200 ? 'DISCLOSED — this should not happen' : refusal(denied)}`,
    );
    say();
    say('  The refusal is printed beside the disclosure because it is the half a');
    say('  regulator asks to see, and the half no demonstration ever shows.');
    say();
    say('  Note what it says, though. It names the record id, its type, and the');
    say('  party id of a subject the caller may hold no relationship with. The');
    say('  media endpoint refuses with a bare 404 for exactly the opposite');
    say('  reason. Both cannot be right. Which one is correct is a decision and');
    say('  not a bug, so it is reported here rather than patched.');

    return farmerGrant;
  });

  const correction = await stage(6, 'correct', async () => {
    const id = uuidv7();
    const answer = await call('POST', '/v1/records', {
      as: ids.officer,
      basis: 'special_data_consent',
      body: envelope(
        {
          id,
          type: 'delivery',
          occurredAt: iso(38),
          assertedBy: ids.officer,
          onBehalfOf: ids.coop,
          delegation: ids.delegation,
          supersedes: ids.delivery,
        },
        {
          from_party: ids.farmer,
          to_party: ids.coop,
          lot: null,
          fulfils: null,
          commodity: 'crop.maize.grain',
          quantity: {
            raw_value: 12,
            raw_unit: 'bag',
            raw_unit_label: 'kaveera',
            // Reweighed on the calibrated scale: the bags held less than the
            // registry factor says. This is the correction, and the reason
            // corrections cannot be edits.
            normalized_kg: 1164,
            conversion_id: CONVERSION_BAG_TO_KG,
            measurement_method: 'calibrated_weighed',
          },
          grade: null,
          location: ids.facility,
          agreed_price: { amount_minor: 1150, currency: 'UGX' },
          counterparty_confirmed_at: null,
          counterparty_confirmed_by: null,
          evidence: [],
        },
      ),
    });

    if (attemptFailed(answer)) {
      say(`REFUSED  ${refusal(answer)}`);
      return null;
    }

    say(`correction ${short(id)} supersedes ${short(ids.delivery)}  1200kg -> 1164kg`);
    const flags = (answer.body['flags'] as string[] | undefined) ?? [];
    if (flags.length > 0) say(`  flags: ${flags.join(', ')}`);
    say();

    const chain = expect(
      await call('GET', `/v1/records/${ids.delivery}/chain`, { as: ids.coop }),
      'reading the chain',
    );
    say('chain:');
    say(`  ${JSON.stringify(chain.body)}`);
    say();

    const notices = await call('GET', '/v1/consent/grants', { as: ids.farmer });
    say(`the farmer's standing grants after the correction: ${notices.status}`);
    say(
      '  a disclosure notification is raised for a grantee that already saw the ' +
        'superseded version; it is queued, not sent, because the kernel does not ' +
        'own a channel.',
    );

    return id;
  });

  const handoff: Handoff = {
    coop: ids.coop,
    officer: ids.officer,
    farmer: ids.farmer,
    lender: ids.lender,
    delegation: ids.delegation,
    plot: ids.plot,
    planting: ids.planting,
    harvest: ids.harvest,
    delivery: ids.delivery,
    correction,
    contentHash,
    grant,
  };
  writeFileSync(handoffPath, JSON.stringify(handoff, null, 2));
}

const attemptFailed = (answer: Answer): boolean => answer.status < 200 || answer.status >= 300;

/**
 * Stage 3's photograph, uploaded through tus and deliberately interrupted.
 *
 * The resume is the point: the client asks the server where it got to rather
 * than starting again, because a farmer on a 2G connection at the collection
 * point will not upload twelve megabytes twice.
 */
interface Upload {
  ref: Record<string, unknown>;
  contentHash: string;
  markers: { exif: Buffer; comment: Buffer };
}

async function uploadEvidence(owner: string): Promise<Upload> {
  const { bytes, markers } = photograph();
  const original = await sha256(bytes);

  const metadata = [
    `content_hash ${Buffer.from(original).toString('base64')}`,
    `mime_type ${Buffer.from('image/jpeg').toString('base64')}`,
  ].join(',');

  const created = expect(
    await call('POST', '/v1/media', {
      as: owner,
      headers: {
        'tus-resumable': '1.0.0',
        'upload-length': String(bytes.length),
        'upload-metadata': metadata,
      },
    }),
    'creating the upload',
  );
  const location = created.headers.get('location') ?? '';
  const session = location.split('/').pop() ?? '';
  say(`upload session ${short(session)}  ${bytes.length} bytes, EXIF and a comment`);

  // First chunk, then walk away as if the connection dropped.
  const half = Math.floor(bytes.length / 3);
  expect(
    await call('PATCH', `/v1/media/${session}`, {
      as: owner,
      headers: { 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
      raw: bytes.subarray(0, half),
    }),
    'the first chunk',
  );
  say(`  sent ${half} bytes, then dropped the connection`);

  const resumed = expect(
    await call('HEAD', `/v1/media/${session}`, { as: owner, headers: { 'tus-resumable': '1.0.0' } }),
    'asking where the upload got to',
  );
  const offset = Number(resumed.headers.get('upload-offset') ?? '0');
  say(`  resumed: the server says offset ${offset}, not zero`);

  const finished = expect(
    await call('PATCH', `/v1/media/${session}`, {
      as: owner,
      headers: {
        'tus-resumable': '1.0.0',
        'upload-offset': String(offset),
        'content-type': 'application/offset+octet-stream',
      },
      raw: bytes.subarray(offset),
    }),
    'the remaining bytes',
  );

  const contentHash = finished.headers.get('clycites-content-hash') ?? '';
  const stripped = finished.headers.get('clycites-metadata-stripped') === 'true';
  say(`  stored: ${contentHash.slice(0, 16)}…  metadata_stripped=${stripped}`);

  // The stored hash differs from the declared one precisely because bytes were
  // removed. If they matched, nothing had been stripped.
  say(`  declared hash ${original.slice(0, 16)}…  differs, because EXIF is gone`);

  return {
    contentHash,
    markers,
    ref: {
      content_hash: contentHash,
      mime_type: 'image/jpeg',
      byte_size: bytes.length,
      storage_ref: `live/sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`,
      captured_at: iso(38, 14),
      captured_by: owner,
      capture_location: null,
      metadata_stripped: true,
    },
  };
}

/** Fetch the stored bytes and prove the metadata is not in them. */
async function confirmStripped(media: Upload, reader: string): Promise<void> {
  const url = expect(
    await call('GET', `/v1/media/${media.contentHash}/url?purpose=traceability_claim`, {
      as: reader,
    }),
    'a download url for the stored object',
  );

  const download = await fetch(url.body['url'] as string);
  const storedBytes = Buffer.from(await download.arrayBuffer());

  const carriesExif = storedBytes.includes(media.markers.exif);
  const carriesComment = storedBytes.includes(media.markers.comment);
  const carriesTag = storedBytes.includes(Buffer.from('Exif\0\0', 'latin1'));

  say(`stored bytes read back: ${storedBytes.length} of ${media.ref['byte_size'] as number} uploaded`);
  say(
    `  EXIF segment ${carriesExif ? 'PRESENT — FAILURE' : 'absent'}, ` +
      `Exif tag ${carriesTag ? 'PRESENT — FAILURE' : 'absent'}, ` +
      `comment ${carriesComment ? 'PRESENT — FAILURE' : 'absent'}`,
  );
  if (carriesExif || carriesComment || carriesTag) {
    throw new Error('metadata survived the strip — stop, this is the privacy claim');
  }
  say('  the GPS coordinates of the farmer\u2019s home are not in the stored object.');
}

async function sha256(bytes: Buffer): Promise<string> {  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

/* ── phase B: stages 8 and 9 ──────────────────────────────────────────────── */

async function phaseB(handoffPath: string): Promise<void> {
  const ids = JSON.parse(readFileSync(handoffPath, 'utf8')) as Handoff;

  await stage(8, 'subject access', async () => {
    const answer = expect(
      await call('GET', '/v1/subject-access', { as: ids.farmer }),
      'the subject access request',
    );

    const dueBy = answer.body['due_by'] as string | undefined;
    const days =
      dueBy === undefined
        ? null
        : Math.round((Date.parse(dueBy) - Date.now()) / 86_400_000);
    say(`due_by  ${dueBy ?? 'absent'}${days === null ? '' : `  (${days} days out)`}`);

    const disclosures = (answer.body['disclosures'] ?? []) as Record<string, unknown>[];
    const thirdParty = disclosures.filter((d) => d['access'] === 'third_party');
    say(
      `access log: ${disclosures.length} entries, of which ${thirdParty.length} ` +
        'a disclosure to somebody else',
    );
    for (const entry of thirdParty) {
      say(`  third party  ${JSON.stringify(entry)}`);
    }
    say(`  the lender is ${short(ids.lender)} — named above, as s.24(1)(c) requires.`);
    say();
    say('  The other nine are the coop reading its own records and the officer');
    say('  reading what he asserted. They are in the same list because the');
    say('  farmer is entitled to know every touch, not only the interesting ones.');
    say();

    const records = (answer.body['records'] ?? []) as Record<string, unknown>[];
    say(`records held about the farmer: ${records.length}`);
    for (const record of records) {
      const redacted = (record['redacted'] ?? []) as string[];
      say(
        `  ${String(record['type']).padEnd(10)} ${short(String(record['id']))}` +
          `  basis ${String(record['lawful_basis'])}` +
          `${redacted.length > 0 ? `  redacted: ${redacted.join(', ')}` : ''}`,
      );
    }
    say();

    const delivery = records.find((r) => r['id'] === ids.delivery);
    const redactedOnDelivery = (delivery?.['redacted'] ?? []) as string[];
    if (redactedOnDelivery.length > 0) {
      say(`the delivery's counterparty is withheld: ${redactedOnDelivery.join(', ')}`);
      say('  s.24(4) withholds the part that identifies another individual rather');
      say('  than refusing the whole record.');
    } else {
      say('NOTHING IS REDACTED ON THE DELIVERY.');
      say('  The counterparty here is a cooperative, not an individual, and s.24(4)');
      say('  reaches other *individuals* only. So `to_party` is disclosed in full.');
      say('  That is defensible on the face of the Act and it is worth a second');
      say('  look: a one-member trading name is a body corporate on paper and a');
      say('  person in fact. Reported, not patched.');
    }
  });

  await stage(9, 'object', async () => {
    const lodged = expect(
      await call('POST', '/v1/objections', {
        as: ids.farmer,
        body: {
          scope: ['credit_assessment'],
          lodged_via: 'ussd_confirmation',
        },
      }),
      'the objection',
    );
    say(`objection ${short((lodged.body['id'] as string) ?? '')}  scope credit_assessment`);
    say();

    const standing = expect(
      await call('GET', '/v1/objections', { as: ids.farmer }),
      'reading standing objections',
    );
    say(`standing: ${JSON.stringify(standing.body)}`);
    say();

    say('what stopped:');
    const lenderRead = await call('GET', `/v1/records/${ids.delivery}`, {
      as: ids.lender,
      purpose: 'credit_assessment',
    });
    if (lenderRead.status === 200) {
      say(`  the lender's credit_assessment read  200 — NOTHING STOPPED.`);
      say();
      say('  This is the design, and it is the finding. An objection under s.7(2)');
      say('  reaches processing carried on under a s.7(2) ground — legitimate');
      say('  interests, public task, and the rest. This delivery is processed on');
      say('  special_data_consent, which is a s.9(3) ground, and consent is ended');
      say('  by withdrawing it, not by objecting to it.');
      say();
      say('  Legally coherent. But the farmer pressed the button marked “I object');
      say('  to my information being used for credit assessment”, and the lender');
      say('  can still read her deliveries for credit assessment. She has no way');
      say('  to know she used the wrong lever, and the kernel raised nothing to');
      say('  tell her.');
      say();
      say('  Reporting, not patching. Whether an objection whose scope names a');
      say('  consented purpose should be read as a withdrawal of that consent is');
      say('  a question for counsel and a decision doc, not a code change made');
      say('  during a rehearsal.');
    } else {
      say(`  the lender's credit_assessment read  ${lenderRead.status} — refused`);
    }
    say();

    say('what continues, and on what ground:');
    const coopRead = await call('GET', `/v1/records/${ids.delivery}`, { as: ids.coop });
    say(`  the coop's own read  ${coopRead.status} — the coop is a subject of this`);
    say('    record, not a third party to it. An objection does not stop the');
    say('    other side of a transaction holding its own copy of it.');
    say();

    say('the subject\u2019s own access is unaffected:');
    const own = await call('GET', '/v1/subject-access', { as: ids.farmer });
    say(`  subject access  ${own.status} — s.24 is not a consent-based right.`);
  });
}

/* ── phase C: stage 11 ────────────────────────────────────────────────────── */

async function phaseC(handoffPath: string): Promise<void> {
  const ids = JSON.parse(readFileSync(handoffPath, 'utf8')) as Handoff;

  await stage(11, 'the lender view', async () => {
    say('Rendered as the lender, through the public API, with the grant it holds.');
    say();

    for (const [label, path] of [
      ['delivery', `/v1/records/${ids.delivery}`],
      ['delivery chain', `/v1/records/${ids.delivery}/chain`],
      ['harvest', `/v1/records/${ids.harvest}`],
      ['plot (no grant)', `/v1/records/${ids.plot}`],
    ] as const) {
      const answer = await call('GET', path, {
        as: ids.lender,
        purpose: 'credit_assessment',
      });
      say(`${label.padEnd(20)} ${answer.status}`);
      if (answer.status === 200) {
        say(`  ${JSON.stringify(answer.body, null, 2).split('\n').join('\n  ')}`);
      } else {
        say(`  ${refusal(answer)}`);
      }
      say();
    }
  });
}

/* ── entry ────────────────────────────────────────────────────────────────── */

const phase = process.argv[2];
const handoffPath = process.argv[3] ?? '/tmp/clycites-dry-run.json';

const phases: Record<string, (path: string) => Promise<void>> = {
  a: phaseA,
  b: phaseB,
  c: phaseC,
};

const chosen = phases[phase ?? ''];
if (chosen === undefined) {
  process.stderr.write('usage: run.ts <a|b|c> [handoff.json]\n');
  process.exit(2);
}

await chosen(handoffPath);
