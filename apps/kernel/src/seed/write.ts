import { DATASET_HEADER, LAWFUL_BASIS_HEADER } from '../api/dataset.js';
import { SUBJECT_HEADER } from '../api/subject.js';
import type { SeedPlan, SeedWrite } from './generate.js';

/**
 * Work order D2. Every record goes in through the public API.
 *
 * Not through the repository, not through a COPY, not through the ingest
 * service directly. It is slower and it is the point: this is the first thing
 * that exercises the contract an application would actually use, and anything
 * awkward here is awkward for every application that follows.
 *
 * The one exception is `registry.unit_conversion`, which has no write endpoint
 * because it is administered rather than asserted. Migration 0014 carries it,
 * and 0023 records why.
 */

export interface WriteOutcome {
  index: number;
  id: string;
  type: string;
  expected: SeedWrite['expect'];
  status: number;
  /** Present when the kernel refused. */
  problem?: { title?: string; detail?: string; type?: string };
  note?: string;
}

export interface GrantOutcome {
  subject: string;
  status: number;
  id: string | null;
  /** Present when the kernel refused, so a failed grant is not silent. */
  problem?: string;
}

export interface WriteReport {
  accepted: number;
  rejected: number;
  /** Writes whose outcome was not the one the fixture asserts. */
  surprises: WriteOutcome[];
  outcomes: WriteOutcome[];
  grants: GrantOutcome[];
}

export interface WriteOptions {
  baseUrl: string;
  /** Called after each write, for progress on a two-minute run. */
  onProgress?: (done: number, total: number) => void;
}

export async function writePlan(
  plan: SeedPlan,
  options: WriteOptions,
): Promise<WriteReport> {
  const outcomes: WriteOutcome[] = [];
  const base = options.baseUrl.replace(/\/$/, '');

  for (const [index, write] of plan.writes.entries()) {
    const document = write.document;
    const asserter = document['asserted_by'] as string;

    const response = await fetch(`${base}/v1/records`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SUBJECT_HEADER]: asserter,
        [DATASET_HEADER]: 'seed',
        [LAWFUL_BASIS_HEADER]: write.basis,
      },
      body: JSON.stringify(document),
    });

    const accepted = response.status === 200 || response.status === 201;
    const outcome: WriteOutcome = {
      index,
      id: document['id'] as string,
      type: document['type'] as string,
      expected: write.expect,
      status: response.status,
      ...(write.note ? { note: write.note } : {}),
    };

    if (!accepted) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      outcome.problem = {
        type: typeof body['type'] === 'string' ? body['type'] : undefined,
        title: typeof body['title'] === 'string' ? body['title'] : undefined,
        detail: typeof body['detail'] === 'string' ? body['detail'] : undefined,
      };
    } else {
      // Drain the body. An unread response keeps the socket busy and the run
      // slows to a crawl somewhere around record four hundred.
      await response.arrayBuffer();
    }

    outcomes.push(outcome);
    options.onProgress?.(index + 1, plan.writes.length);
  }

  const surprises = outcomes.filter(
    (o) => (o.status === 200 || o.status === 201) !== (o.expected === 'accepted'),
  );

  const grants = await writeGrants(plan, base);

  return {
    accepted: outcomes.filter((o) => o.status === 200 || o.status === 201).length,
    rejected: outcomes.filter((o) => o.status !== 200 && o.status !== 201).length,
    surprises,
    outcomes,
    grants,
  };
}

/**
 * Grants go in last, as the subject, through the same endpoint an application
 * would use. A grant names a subject and a grantee, so neither can be recorded
 * before both party records exist.
 */
async function writeGrants(plan: SeedPlan, base: string): Promise<GrantOutcome[]> {
  const outcomes: GrantOutcome[] = [];

  for (const grant of plan.grants) {
    const response = await fetch(`${base}/v1/consent/grants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SUBJECT_HEADER]: grant.subject,
        [DATASET_HEADER]: 'seed',
      },
      body: JSON.stringify({
        grantee: grant.grantee,
        purpose: grant.purpose,
        record_types: grant.record_types,
        expires_at: grant.expires_at,
        granted_via: grant.granted_via,
      }),
    });

    const accepted = response.status === 200 || response.status === 201;
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    outcomes.push({
      subject: grant.subject,
      status: response.status,
      id: accepted && typeof body['id'] === 'string' ? body['id'] : null,
      ...(accepted ? {} : { problem: String(body['detail'] ?? body['title'] ?? '') }),
    });
  }

  return outcomes;
}
