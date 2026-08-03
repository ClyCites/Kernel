import { Inject, Injectable } from '@nestjs/common';

import { RecordRejected } from './errors.js';
import { RecordRepository } from './record.repository.js';
import type { StoredRecord } from './record.js';

export interface DelegationRequest {
  delegation: string;
  /** The party being acted for — `on_behalf_of`. */
  delegator: string;
  /** The party doing the acting — `asserted_by`. */
  delegate: string;
  recordType: string;
  occurredAt: string;
}

export interface DelegationGrant {
  /** The delegation record actually relied on, after resolving corrections. */
  id: string;
  /** Spec §5.3. `organisational_bylaw` is weaker evidence and gets labelled. */
  basis: string | null;
}

/**
 * Spec §4 and §5.3. Acting for another party requires a Delegation that was
 * active at `occurred_at`.
 *
 * This resolves at **ingest**, not at read time (brief §4 invariant 3). A record
 * whose authority cannot be established must not enter the log at all — leaving
 * it to be checked on the way out means unauthorised claims sit in the log
 * looking like facts until someone queries them.
 */
@Injectable()
export class DelegationService {
  constructor(
    @Inject(RecordRepository) private readonly repository: RecordRepository,
  ) {}

  async authorise(request: DelegationRequest): Promise<DelegationGrant> {
    const original = await this.repository.findById(request.delegation);
    if (!original || original.type !== 'delegation') {
      throw new RecordRejected(
        'delegation_not_authorised',
        `delegation ${request.delegation} is not in the log`,
        [{ path: 'delegation', message: 'no such delegation record' }],
      );
    }

    // A delegation can itself have been corrected (a widened scope, a later
    // expiry). The authority that applies is the tip of that chain.
    const chain = await this.repository.findSupersessionChain(original.id);
    const tips = chain.filter(
      (record) => !chain.some((other) => other.supersedes === record.id),
    );

    if (tips.length > 1) {
      // Spec §8 rule 4: a fork is a real dispute about who may act for whom.
      // Guessing is worse than refusing.
      throw new RecordRejected(
        'delegation_not_authorised',
        `delegation ${request.delegation} has competing corrections and cannot be relied on`,
        [{ path: 'delegation', message: 'unresolved supersession fork' }],
      );
    }

    const effective = tips[0] ?? original;

    for (const link of chain) {
      if (await this.repository.isRetracted(link.id)) {
        throw new RecordRejected(
          'delegation_not_authorised',
          `delegation ${request.delegation} has been retracted`,
          [{ path: 'delegation', message: 'delegation is retracted' }],
        );
      }
    }

    this.check(effective, request);

    return {
      id: effective.id,
      basis: asString(effective.body['granted_via']),
    };
  }

  private check(delegation: StoredRecord, request: DelegationRequest): void {
    const body = delegation.body;
    const at = Date.parse(request.occurredAt);

    const reject = (message: string): never => {
      throw new RecordRejected(
        'delegation_not_authorised',
        `delegation ${delegation.id} does not authorise this record: ${message}`,
        [{ path: 'delegation', message }],
      );
    };

    if (asString(body['delegator']) !== request.delegator) {
      reject('the delegation was granted by a different party');
    }
    if (asString(body['delegate']) !== request.delegate) {
      reject('the delegation was granted to a different party');
    }

    // Deny unless listed. Work order M5.
    //
    // Anything that is not an array of strings naming this exact record type
    // is a refusal — a missing scope, an empty one, a scope holding numbers or
    // objects, or a scope naming something else. There is deliberately no
    // wildcard and no "covers everything" value: the widening is easy to add
    // later and impossible to take back once cooperatives depend on it.
    //
    // Open decision D7 is whether this should also be per field. It should
    // not, yet. Per-record-type is the narrower option, and narrowing after
    // the fact breaks every delegation in the field, where widening breaks
    // nothing. The metric in `delegationBasisCensus` is what will answer it.
    const scope = Array.isArray(body['scope'])
      ? body['scope'].filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (!scope.includes(request.recordType)) {
      reject(`the delegation does not cover "${request.recordType}"`);
    }

    const grantedAt = Date.parse(asString(body['granted_at']) ?? '');
    if (Number.isFinite(grantedAt) && at < grantedAt) {
      reject('the record predates the delegation');
    }

    const expiresAt = Date.parse(asString(body['expires_at']) ?? '');
    if (Number.isFinite(expiresAt) && at >= expiresAt) {
      reject('the delegation had expired');
    }

    const revokedAt = Date.parse(asString(body['revoked_at']) ?? '');
    if (Number.isFinite(revokedAt) && at >= revokedAt) {
      reject('the delegation had been revoked');
    }
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
