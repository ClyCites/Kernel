import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import {
  DisclosureRepository,
  type DisclosureRow,
} from '../audit/disclosure.repository.js';
import { RecordRepository } from '../records/record.repository.js';
import { toDocument, type Dataset, type RecordDocument } from '../records/record.js';
import { PARTY_SUBJECT_FIELDS, subjectFields } from '../records/subjects.js';
import { ConsentRepository, type ConsentGrantRow } from './consent.repository.js';
import { ObjectionRepository, type ObjectionRow } from './objection.repository.js';
import {
  ClientRepository,
  type ClientAuthorisationRow,
} from '../identity/client.repository.js';

/**
 * s.24(9). The clock the request starts, carried in the response so the
 * deadline is the subject's to hold us to rather than ours to remember.
 */
export const RESPONSE_DAYS = 30;

/**
 * One page is the whole answer or it is not an answer.
 *
 * A subject-access response that silently stops at a page boundary is worse
 * than a slow one, so the cap is high and breaching it is reported rather than
 * paginated. A subject with more records than this needs an export, not a
 * second page they will never ask for.
 */
export const MAX_RECORDS = 1000;

const REDACTED = '[redacted]';

/**
 * The envelope fields that name a party. Body fields come from
 * `PARTY_SUBJECT_FIELDS`; these are on every record regardless of type.
 */
const ENVELOPE_PARTY_FIELDS = ['asserted_by', 'on_behalf_of'] as const;

export interface SubjectAccessRecord {
  id: string;
  type: string;
  occurred_at: string;
  recorded_at: string;
  /** The ground it was collected on. s.7(3) turns on this and so does erasure. */
  lawful_basis: string;
  retracted: boolean;
  superseded_by: string[];
  document: RecordDocument;
  /** Fields blanked under s.24(4). Named so the subject can ask about them. */
  redacted: string[];
}

export interface SubjectAccessResponse {
  subject: string;
  dataset: Dataset;
  prepared_at: string;
  /** s.24(9). */
  due_by: string;
  /** s.24(1)(a): whether anything is held at all. */
  held: boolean;
  records: SubjectAccessRecord[];
  /** s.24(1)(c): who has had access, and on what permission. */
  disclosures: DisclosureRow[];
  consents: ConsentGrantRow[];
  client_authorisations: ClientAuthorisationRow[];
  objections: ObjectionRow[];
  /** True when the answer hit `MAX_RECORDS` and is therefore incomplete. */
  truncated: boolean;
  notice: string[];
}

const NOTICE: readonly string[] = [
  'Fields marked ' +
    REDACTED +
    ' identify another individual. s.24(4) and s.24(7) require withholding ' +
    'that part rather than refusing the whole record, so the record is here ' +
    'and only their particulars are not.',
  'Organisations are not redacted. A cooperative or a business you dealt ' +
    'with is named, because s.24(4) protects another individual and not a ' +
    'trading identity you need to be able to point at.',
  'Access shown here is disclosure to someone else. Your own reads are not ' +
    'listed, and neither are refusals — a request that was denied disclosed ' +
    'nothing.',
];

@Injectable()
export class SubjectAccessService {
  private requests = 0;
  private totalMs = 0;
  private slowestMs = 0;

  constructor(
    @Inject(RecordRepository) private readonly records: RecordRepository,
    @Inject(DisclosureRepository) private readonly disclosures: DisclosureRepository,
    @Inject(ConsentRepository) private readonly consent: ConsentRepository,
    @Inject(ObjectionRepository) private readonly objections: ObjectionRepository,
    @Inject(ClientRepository) private readonly clients: ClientRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Everything held about one subject, assembled for them.
   *
   * This does not go through the consent guard, and that is the point: the
   * guard answers "may this party see someone else's record", and a subject
   * asking for their own data is not that question. It is scoped to the
   * verified subject at the controller and nowhere else takes a subject from
   * request input.
   */
  async assemble(
    subject: string,
    dataset: Dataset,
    correlationId?: string | null,
  ): Promise<SubjectAccessResponse> {
    const started = Date.now();

    const [held, disclosures, consents, objections, clientAuthorisations] = await Promise.all([
      this.records.list({
        subject: { id: subject, fields: subjectFields() },
        // A superseded or retracted record is still held, and a subject asking
        // what we have is not asking what we would show a buyer.
        includeSuperseded: true,
        includeRetracted: true,
        dataset,
        limit: MAX_RECORDS + 1,
      }),
      this.disclosures.disclosuresTo(subject, dataset),
      this.consent.grantsBySubject(subject, dataset),
      this.objections.objectionsBySubject(subject, dataset),
      this.clients.authorisationsByParty(subject),
    ]);

    const truncated = held.length > MAX_RECORDS;
    const page = truncated ? held.slice(0, MAX_RECORDS) : held;

    const kinds = await this.records.partyKinds(
      page.flatMap((row) => partyValues(toDocument(row), row.type)),
      dataset,
    );

    const records = page.map((row) => {
      const { document, redacted } = redact(toDocument(row), row.type, subject, kinds);
      return {
        id: row.id,
        type: row.type,
        occurred_at: row.occurred_at,
        recorded_at: row.recorded_at,
        lawful_basis: row.lawful_basis,
        retracted: row.retracted,
        superseded_by: row.superseded_by,
        document,
        redacted,
      };
    });

    const preparedAt = new Date();
    const dueBy = new Date(preparedAt.getTime() + RESPONSE_DAYS * 86_400_000);

    await this.audit.record({
      action: 'record.read',
      outcome: 'allowed',
      dataset,
      reason: 'subject_access',
      actor: subject,
      subjects: [subject],
      records: records.map((record) => record.id),
      detail: {
        returned: records.length,
        disclosures: disclosures.length,
        truncated,
      },
      correlationId: correlationId ?? null,
    });

    this.observe(Date.now() - started);

    return {
      subject,
      dataset,
      prepared_at: preparedAt.toISOString(),
      due_by: dueBy.toISOString(),
      held: records.length > 0,
      records,
      disclosures,
      consents,
      client_authorisations: clientAuthorisations,
      objections,
      truncated,
      notice: [...NOTICE],
    };
  }

  /** For /metrics. Latency is worth watching before the thirty days matter. */
  latency(): { requests: number; totalMs: number; slowestMs: number } {
    return {
      requests: this.requests,
      totalMs: this.totalMs,
      slowestMs: this.slowestMs,
    };
  }

  private observe(elapsed: number): void {
    this.requests += 1;
    this.totalMs += elapsed;
    if (elapsed > this.slowestMs) this.slowestMs = elapsed;
  }
}

/** Every party id a record names, envelope and body alike. */
function partyValues(document: RecordDocument, type: string): string[] {
  const found: string[] = [];
  for (const field of ENVELOPE_PARTY_FIELDS) {
    const value = document[field];
    if (typeof value === 'string') found.push(value);
  }
  for (const field of PARTY_SUBJECT_FIELDS[type] ?? []) {
    found.push(...valuesAt(document, field));
  }
  return found;
}

/**
 * Blank another individual's particulars, keep the record.
 *
 * s.24(4) and s.24(7) offer redaction explicitly, so a commingled lot or a
 * delivery with a counterparty is answered rather than refused. Wholesale
 * refusal would be the wrong answer to the commonest shape of record we hold.
 */
function redact(
  document: RecordDocument,
  type: string,
  subject: string,
  kinds: ReadonlyMap<string, string>,
): { document: RecordDocument; redacted: string[] } {
  const conceal = (id: string): boolean =>
    id !== subject && (kinds.get(id) ?? 'person') === 'person';

  const redacted: string[] = [];
  const copy: RecordDocument = { ...document };

  for (const field of ENVELOPE_PARTY_FIELDS) {
    const value = copy[field];
    if (typeof value === 'string' && conceal(value)) {
      copy[field] = REDACTED;
      redacted.push(field);
    }
  }

  for (const field of PARTY_SUBJECT_FIELDS[type] ?? []) {
    const [outer, inner] = field.split('[].');
    if (outer === undefined) continue;

    if (inner === undefined) {
      const value = copy[outer];
      if (typeof value === 'string' && conceal(value)) {
        copy[outer] = REDACTED;
        redacted.push(outer);
      }
      continue;
    }

    const list = copy[outer];
    if (!Array.isArray(list)) continue;
    let touched = false;
    copy[outer] = list.map((entry) => {
      if (entry === null || typeof entry !== 'object') return entry;
      const item = entry as Record<string, unknown>;
      const value = item[inner];
      if (typeof value !== 'string' || !conceal(value)) return entry;
      touched = true;
      return { ...item, [inner]: REDACTED };
    });
    if (touched) redacted.push(field);
  }

  return { document: copy, redacted };
}

function valuesAt(document: RecordDocument, field: string): string[] {
  const [outer, inner] = field.split('[].');
  if (outer === undefined) return [];

  if (inner === undefined) {
    const value = document[outer];
    return typeof value === 'string' ? [value] : [];
  }

  const list = document[outer];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const value = (entry as Record<string, unknown>)[inner];
    return typeof value === 'string' ? [value] : [];
  });
}
