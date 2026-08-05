import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { AuditService } from '../audit/audit.service.js';
import {
  isLawfulBasis,
  objectionStops,
  type LawfulBasis,
} from '../records/lawful-basis.js';
import { partiesOf, partyHopOf } from '../records/subjects.js';
import { toDocument, type Dataset, type StoredRecord } from '../records/record.js';
import { ConsentRepository, type ConsentGrantRow } from './consent.repository.js';
import {
  ObjectionRepository,
  type ObjectionChannel,
  type ObjectionRow,
  type WithdrawalChannel,
} from './objection.repository.js';

export const OBJECTION_CHANNELS = [
  'in_person',
  'ussd_confirmation',
  'written',
] as const;

/**
 * `ussd_confirmation` is missing on purpose. Lodging an objection protects the
 * subject and a PIN on a shared handset is enough for that; withdrawing one
 * removes the protection and is not.
 */
export const WITHDRAWAL_CHANNELS = ['in_person', 'written'] as const;

export interface LodgeRequest {
  subject: string;
  scope: string[] | null;
  lodgedVia: ObjectionChannel;
  /** The party at the keyboard. An officer may lodge for a farmer. */
  lodgedBy: string;
  /** The Delegation relied on, when it is not the subject lodging. */
  delegation: string | null;
  evidence: unknown[];
  dataset: Dataset;
  correlationId?: string | null | undefined;
}

export interface BasisOutcome {
  record_type: string;
  lawful_basis: string;
  records: number;
  /** Present only where processing continues. Why it continues. */
  ground?: string;
}

/**
 * A grant the subject can withdraw, offered when the objection stopped
 * nothing. Deliberately not the whole grant row: the subject needs to know
 * who, what for, and which id to quote.
 */
export interface WithdrawableGrant {
  grant: string;
  grantee: string;
  purpose: string;
  record_types: string[];
  granted_at: string;
}

/**
 * What the objection actually did, as one word.
 *
 * `stopped_nothing_*` are separate codes rather than one, because they call
 * for different next steps and are counted separately on /metrics. A rising
 * `stopped_nothing_consent_only` means the interface is telling people to
 * object when what they need is to withdraw.
 */
export type ObjectionEffect =
  | 'stopped_some'
  | 'stopped_nothing_no_records'
  | 'stopped_nothing_out_of_scope'
  | 'stopped_nothing_consent_only'
  | 'stopped_nothing_exempt';

export interface ObjectionOutcome {
  objection: ObjectionRow;
  /** One word for what happened. Read this before reading the lists. */
  effect: ObjectionEffect;
  /** The same thing in a sentence a person can act on. */
  headline: string;
  stopped: BasisOutcome[];
  continuing: BasisOutcome[];
  /**
   * The action that would work, when the one taken did not. Empty when the
   * objection stopped something, or when there is nothing to withdraw.
   */
  withdrawable: WithdrawableGrant[];
  notice: string[];
}

/**
 * What an objection does not reach. Stated in the response and not only in a
 * decision doc, because a subject who is told "done" and assumes it means
 * erasure has been misled by omission.
 */
const NOTICE: readonly string[] = [
  'This is not erasure. The records remain in the log, which is append-only. ' +
    'Erasure is s.16 and s.18 and is not implemented.',
  'This does not undo disclosures already made. Notifying parties who have ' +
    'already received these records is a separate right and is not implemented.',
  'This does not touch the audit log. Access records are kept under ' +
    's.24(1)(c) and must survive an objection.',
  'This does not remove another party’s own record of a transaction it was ' +
    'part of. A cooperative that recorded a delivery it made keeps its copy ' +
    'for its own accounting; what stops is disclosure of it to others.',
  'Your own access is unaffected. You can still see every record about you, ' +
    'and you never have to withdraw this objection to do so.',
];

export class ObjectionRefused extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'ObjectionRefused';
  }
}

/**
 * Objection under s.7(3). Work order J2.
 *
 * Distinct from withdrawal, which is narrower: withdrawal (0021) names one
 * grant and stops that grantee for that purpose. An objection is against the
 * processing itself, and s.7(3) exempts anything collected under s.7(2) — so
 * it resolves against each record's stored `lawful_basis` and stops some
 * records while leaving others running.
 */
@Injectable()
export class ObjectionService {
  constructor(
    @Inject(ObjectionRepository) private readonly repository: ObjectionRepository,
    @Inject(ConsentRepository) private readonly consent: ConsentRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async lodge(request: LodgeRequest): Promise<ObjectionOutcome> {
    if (request.lodgedBy !== request.subject && request.delegation === null) {
      throw new ObjectionRefused(
        'delegation_required',
        'lodging an objection for another party requires the delegation it rests on',
      );
    }

    // Resolved before the insert, not after it. `kernel.objection` is
    // append-only at the role level, so there is no UPDATE to add the effect
    // with afterwards — the row has to be written complete. That is the
    // constraint working: an objection whose recorded effect could be edited
    // later is not evidence of what the subject was told.
    const resolved = this.resolve(
      request.scope,
      await this.repository.basisCensusForSubject(request.subject, request.dataset),
      await this.consent.grantsBySubject(request.subject, request.dataset),
    );

    const objection = await this.repository.insertObjection({
      id: uuidv7(),
      subject: request.subject,
      scope: request.scope,
      lodgedAt: new Date().toISOString(),
      lodgedVia: request.lodgedVia,
      lodgedBy: request.lodgedBy,
      delegation: request.delegation,
      evidence: request.evidence,
      dataset: request.dataset,
      // Frozen here. The effect is a function of the records that existed at
      // this moment, and what is worth counting is what the subject was told
      // — not what the same objection would do today.
      effect: resolved.effect,
    });

    const outcome: ObjectionOutcome = { ...resolved, objection };

    await this.audit.record({
      action: 'record.write',
      outcome: 'allowed',
      dataset: request.dataset,
      reason: 'objection_lodged',
      actor: request.lodgedBy,
      subjects: [request.subject],
      records: [objection.id],
      recordTypes: ['objection'],
      detail: {
        lodged_via: request.lodgedVia,
        delegated: request.delegation !== null,
        stopped: outcome.stopped.reduce((sum, row) => sum + row.records, 0),
        continuing: outcome.continuing.reduce((sum, row) => sum + row.records, 0),
        // The metric reads this. An objection that stops nothing is not an
        // error and will never appear in an error rate, so it has to be
        // counted deliberately or it is invisible.
        effect: outcome.effect,
      },
      correlationId: request.correlationId ?? null,
    });

    return outcome;
  }

  /**
   * The asymmetry, and it is the point of this method. An officer may lodge
   * and may not withdraw: the act that protects the subject is delegable, the
   * act that removes the protection is not, because the party best placed to
   * want it removed is the one whose access it restricts.
   */
  async withdraw(
    id: string,
    requester: string,
    via: WithdrawalChannel,
    reason: string | null,
    dataset: Dataset,
    correlationId?: string | null,
  ): Promise<ObjectionRow | null> {
    const standing = await this.repository.objectionsBySubject(requester, dataset);
    const target = standing.find((objection) => objection.id === id);
    if (target === undefined) {
      // Not found and not yours read the same on purpose: an officer probing
      // ids should not learn which of them exist.
      return null;
    }

    const row = await this.repository.withdrawObjection(
      id,
      uuidv7(),
      requester,
      new Date().toISOString(),
      via,
      reason,
    );

    await this.audit.record({
      action: 'record.write',
      outcome: 'allowed',
      dataset,
      reason: 'objection_withdrawn',
      actor: requester,
      subjects: [requester],
      records: [id],
      recordTypes: ['objection'],
      detail: { withdrawn_via: via },
      correlationId: correlationId ?? null,
    });

    return row;
  }

  async standing(
    subject: string,
    dataset: Dataset,
    correlationId?: string | null,
  ): Promise<ObjectionRow[]> {
    const objections = await this.repository.objectionsBySubject(subject, dataset);

    await this.audit.record({
      action: 'record.read',
      outcome: 'allowed',
      dataset,
      reason: 'self_read',
      actor: subject,
      subjects: [subject],
      records: objections.map((objection) => objection.id),
      recordTypes: ['objection'],
      detail: { by: 'own_objections', returned: objections.length },
      correlationId: correlationId ?? null,
    });

    return objections;
  }

  /**
   * Which of these records must not be disclosed to this reader.
   *
   * Resolved per request rather than pre-computed: an exclusion list would be
   * a second copy of the answer, stale the moment an objection is lodged or
   * withdrawn, and the record's basis is what decides it anyway.
   */
  async withheld(
    records: readonly StoredRecord[],
    requester: string | null,
    dataset: Dataset,
  ): Promise<Set<string>> {
    const withheld = new Set<string>();
    if (records.length === 0) return withheld;

    const candidates = records
      .map((record) => {
        const document = toDocument(record);
        return {
          record,
          parties: partiesOf(document),
          via: partyHopOf(document),
        };
      })
      .filter(({ record }) => stoppable(record.lawful_basis))
      // The asserter and the party it acted for keep their own record of their
      // own transaction. What an objection stops is disclosure, not the
      // cooperative's own processing of a delivery it made.
      .filter(
        ({ record }) =>
          record.asserted_by !== requester && record.on_behalf_of !== requester,
      );

    if (candidates.length === 0) return withheld;

    const hops = candidates
      .filter((candidate) => candidate.parties.length === 0 && candidate.via !== null)
      .map((candidate) => candidate.via as string);
    const resolved = await this.consent.partiesOfRecords(hops, dataset);

    const effective = candidates
      .map((candidate) => ({
        record: candidate.record,
        parties:
          candidate.parties.length > 0 || candidate.via === null
            ? candidate.parties
            : (resolved.get(candidate.via) ?? []),
      }))
      // The subject keeps their own access. An objection restricts others
      // processing your data; it is not an instruction to stop showing it to
      // you, and s.24 does not condition the right of access on not having
      // objected. The same carve-out covers subject access when J3 lands.
      .filter((candidate) => !candidate.parties.includes(requester ?? ''));

    const objections = await this.repository.standingFor(
      effective.flatMap((candidate) => candidate.parties),
      dataset,
    );
    if (objections.size === 0) return withheld;

    for (const candidate of effective) {
      const objected = candidate.parties.some((party) =>
        (objections.get(party) ?? []).some((objection) =>
          inScope(objection.scope, candidate.record.type),
        ),
      );
      if (objected) withheld.add(candidate.record.id);
    }

    return withheld;
  }

  /** Both sets, enumerated. Never a boolean. */
  private resolve(
    scope: string[] | null,
    census: readonly { type: string; basis: string; records: number }[],
    grants: readonly ConsentGrantRow[],
  ): Omit<ObjectionOutcome, 'objection'> {
    const stopped: BasisOutcome[] = [];
    const continuing: BasisOutcome[] = [];

    for (const row of census) {
      const entry: BasisOutcome = {
        record_type: row.type,
        lawful_basis: row.basis,
        records: row.records,
      };

      if (!inScope(scope, row.type)) {
        continuing.push({
          ...entry,
          ground: 'outside the scope of this objection',
        });
        continue;
      }
      if (!stoppable(row.basis)) {
        continuing.push({
          ...entry,
          ground: `collected under s.7(2): ${row.basis}, which s.7(3) exempts`,
        });
        continue;
      }
      stopped.push(entry);
    }

    // FINDING, fixed here: this used to return the two lists and stop. That is
    // legally accurate and it is not an answer. She pressed a button marked "I
    // object", nothing happened, and nothing told her — so the response now
    // says what happened in one sentence and, where the answer is "nothing",
    // offers the act that would have worked.
    const inScopeContinuing = continuing.filter((row) => row.ground?.startsWith('collected'));
    const consentOnly =
      inScopeContinuing.length > 0 &&
      inScopeContinuing.every((row) => row.lawful_basis === 'consent');

    let effect: ObjectionEffect;
    let headline: string;

    if (stopped.length > 0) {
      effect = 'stopped_some';
      headline =
        `This objection stops disclosure of ` +
        `${stopped.reduce((sum, row) => sum + row.records, 0)} record(s) to others.`;
    } else if (census.length === 0) {
      effect = 'stopped_nothing_no_records';
      headline =
        'Nothing stopped, because there are no records about you here to stop. ' +
        'The objection is on file and will apply to anything recorded later.';
    } else if (inScopeContinuing.length === 0) {
      effect = 'stopped_nothing_out_of_scope';
      headline =
        'Nothing stopped. Every record about you is of a type this objection ' +
        'did not name. Lodging it without a scope would reach all of them.';
    } else if (consentOnly) {
      effect = 'stopped_nothing_consent_only';
      headline =
        'Nothing stopped. This processing runs on your consent, and consent ' +
        'ends by withdrawal, not by objection — s.7(3) only reaches ' +
        'processing done without asking you. Withdraw the grants listed ' +
        'below and it stops.';
    } else {
      effect = 'stopped_nothing_exempt';
      headline =
        'Nothing stopped. Every record about you within this objection is ' +
        'held on a ground s.7(3) exempts, listed below with the reason.';
    }

    // Only where the objection failed, and only grants it would plausibly have
    // been aimed at. Offering the full list after a successful objection would
    // read as a demand to give up more than was asked.
    const withdrawable =
      stopped.length > 0
        ? []
        : grants
            .filter((grant) => grant.revoked_at === null)
            .filter((grant) => grant.record_types.some((type) => inScope(scope, type)))
            .map((grant) => ({
              grant: grant.id,
              grantee: grant.grantee,
              purpose: grant.purpose,
              record_types: grant.record_types,
              granted_at: grant.granted_at,
            }));

    return {
      effect,
      headline,
      stopped,
      continuing,
      withdrawable,
      notice: [...NOTICE],
    };
  }
}

function inScope(scope: string[] | null, type: string): boolean {
  return scope === null || scope.includes(type);
}

/**
 * A record with no recorded ground cannot claim a s.7(2) exemption it never
 * stated, so an unstated basis stops.
 */
function stoppable(basis: string | null): boolean {
  if (basis === null) return true;
  if (!isLawfulBasis(basis)) return true;
  return objectionStops(basis as LawfulBasis);
}
