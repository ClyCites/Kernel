import { Inject, Injectable } from '@nestjs/common';

import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import type { Dataset } from '../records/record.js';
import {
  ConsentRepository,
  type ConsentGrantRow,
  type MembershipQuery,
} from './consent.repository.js';

/**
 * The decision point. Work order N, replacing the stub.
 *
 * Every path that can disclose personal data comes through `decide`. It answers
 * one question in one order: **what kind of access is this**, and only then
 * whether a grant is needed and whether one exists.
 *
 * Four classes, and the class is derived from the record, never from the
 * request. A caller that could nominate its own subjects, or assert its own
 * membership, would have a bypass rather than a gate.
 *
 *   self         the requester is a party to the record
 *   asserter     the requester stated it — you cannot withhold a record from
 *                the party that supplied it
 *   member body  the requester is an organisation the subject belongs to, and
 *                the record was asserted by or transacted with it (s.9(3)(c))
 *   third party  everything else, and it always needs a grant
 *
 * See docs/decisions/0029-consent.md.
 */

/** Consent is purpose-bound, so a purpose is not free text. */
export const CONSENT_PURPOSES = [
  'credit_assessment',
  'insurance_underwriting',
  'input_supply',
  'market_intelligence',
  'traceability_claim',
  'advisory',
  'research',
  'regulatory_reporting',
] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** How a subject actually said yes. A grant nobody can evidence is not one. */
export const CONSENT_CHANNELS = [
  'in_person_signature',
  'ussd_confirmation',
  'witnessed',
] as const;

export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

/** Kernel operations that read records without disclosing them to anyone. */
export const INTEGRITY_OPERATIONS = [
  'supersession_resolution',
  'mass_balance',
  'anchoring',
] as const;

export type IntegrityOperation = (typeof INTEGRITY_OPERATIONS)[number];

export const ACCESS_CLASSES = [
  'self',
  'asserter',
  'member_body',
  'third_party',
] as const;

export type AccessClass = (typeof ACCESS_CLASSES)[number];

export type ConsentReason =
  // allowed
  | 'self_read'
  | 'asserter_read'
  | 'member_body'
  | 'member_body_with_grant'
  | 'third_party_with_grant'
  | 'kernel_integrity'
  // denied
  | 'unattributed_record'
  | 'no_attributable_party'
  | 'no_verified_subject'
  | 'purpose_required'
  | 'no_grant'
  | 'grant_expired'
  | 'grant_revoked'
  | 'grant_wrong_purpose'
  | 'grant_wrong_record_type'
  | 'financial_needs_consent'
  | 'lawful_basis_forbids';

/** Never a bare boolean: the reason is what goes in the audit log. */
export interface ConsentDecision {
  allowed: boolean;
  reason: ConsentReason;
  detail: string;
  /** The grants actually relied on. Empty when none was needed. */
  grants: string[];
  /** The strongest class the request had to be justified under. */
  access?: AccessClass | undefined;
}

/**
 * One record, as the decision point needs to see it. Every field comes from the
 * stored record; none of it is caller input.
 */
export interface RecordFacts {
  id: string;
  type: string;
  /** Everything the record is about, parties and entities alike. For audit. */
  subjects: readonly string[];
  /** Only the parties. A lot cannot give a grant. */
  parties: readonly string[];
  asserted_by: string;
  occurred_at: string;
  /** s.9(1) special data: a priced delivery, an obligation, a settlement. */
  financial: boolean;
  lawful_basis: string;
}

export interface ConsentRequest {
  records: readonly RecordFacts[];
  /** The party asking. Null when no verified subject reached the kernel. */
  requester: string | null;
  /** Why the data is wanted. Null is only viable for self and asserter reads. */
  purpose: ConsentPurpose | null;
  dataset: Dataset;
  at: string;
}

export class ConsentDenied extends Error {
  readonly code = 'consent_denied';

  constructor(readonly decision: ConsentDecision) {
    super(decision.detail);
    this.name = 'ConsentDenied';
  }
}

/** Weakest first. The decision reports the strongest one the request needed. */
const CLASS_ORDER: Record<AccessClass, number> = {
  self: 0,
  asserter: 1,
  member_body: 2,
  third_party: 3,
};

@Injectable()
export class ConsentService {
  constructor(
    @Inject(ConsentRepository) private readonly repository: ConsentRepository,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<
      KernelConfig,
      'S9_CONSENT_REQUIRED_FOR_MEMBER_BODY'
    > = { S9_CONSENT_REQUIRED_FOR_MEMBER_BODY: true },
  ) {}

  /**
   * The only decision function.
   *
   * Whole-request, not per-record: a page containing one record the caller may
   * not see is refused entirely. Half a page looks like an answer and is not
   * one.
   */
  async decide(request: ConsentRequest): Promise<ConsentDecision> {
    const { requester } = request;
    if (request.records.length === 0) {
      return deny('unattributed_record', 'there is nothing to decide about');
    }

    for (const record of request.records) {
      // A record nobody can be identified from cannot be governed: no grant
      // resolves against it and no revocation reaches it. Spec §10.
      if (record.subjects.length === 0) {
        return deny(
          'unattributed_record',
          `${record.type} ${record.id} names no subject, so no consent decision can be resolved against it`,
        );
      }
    }

    if (requester === null) {
      return deny(
        'no_verified_subject',
        'no verified subject reached the kernel, so no record may be released',
      );
    }

    const membership = await this.resolveMembership(requester, request);

    const grants: string[] = [];
    let strongest: AccessClass = 'self';

    for (const record of request.records) {
      const access = classify(record, requester, membership);
      if (CLASS_ORDER[access] > CLASS_ORDER[strongest]) strongest = access;

      const refusal = this.permitsBasis(record, access);
      if (refusal !== null) return refusal;

      if (!this.needsGrant(record, access)) continue;

      const counterparties = record.parties.filter((id) => id !== requester);
      if (counterparties.length === 0) {
        return deny(
          'no_attributable_party',
          `${record.type} ${record.id} names no party who could grant consent for it`,
        );
      }
      if (request.purpose === null) {
        return deny(
          'purpose_required',
          'a purpose is required for any access beyond the requester’s own records',
        );
      }

      const held = await this.repository.grantsFor(
        requester,
        counterparties,
        request.dataset,
      );

      for (const subject of counterparties) {
        const resolved = resolveGrant(
          held.filter((grant) => grant.subject === subject),
          { purpose: request.purpose, recordType: record.type, at: request.at },
        );

        if (resolved.grant === null) {
          // Member body plus financial data plus no grant is the s.9 case, and
          // it gets its own reason so the flag's effect is legible in the
          // audit log rather than hidden inside a generic refusal.
          const reason =
            access === 'member_body' && resolved.reason === 'no_grant'
              ? 'financial_needs_consent'
              : resolved.reason;

          return deny(
            reason,
            `${resolved.detail} (${record.type} ${record.id}, subject ${subject})`,
          );
        }
        grants.push(resolved.grant.id);
      }
    }

    return {
      allowed: true,
      reason: allowedReason(strongest, grants.length > 0),
      detail: detailFor(strongest, grants.length),
      grants: [...new Set(grants)],
      access: strongest,
    };
  }

  /**
   * Whether this class of access, for this record, needs a grant on top.
   *
   * The one place the s.9 question lands. Everything else about member-body
   * access is settled; whether it reaches financial data is not, so it is a
   * flag that defaults to requiring consent and nothing else in the module
   * branches on s.9.
   */
  private needsGrant(record: RecordFacts, access: AccessClass): boolean {
    if (access === 'self' || access === 'asserter') return false;
    if (access === 'third_party') return true;
    return record.financial && this.config.S9_CONSENT_REQUIRED_FOR_MEMBER_BODY;
  }

  /**
   * Whether the ground the record was collected on covers this use.
   *
   * Narrow on purpose. s.9(1) prohibits processing financial information
   * outside s.9(3), and of those limbs only (b) — consent — is reachable here,
   * so a financial record held on anything else may not go to anyone but the
   * party that supplied it or a party to it. Ingest has refused such records
   * since 0013; this catches the ones written before it.
   */
  private permitsBasis(
    record: RecordFacts,
    access: AccessClass,
  ): ConsentDecision | null {
    if (access === 'asserter' || access === 'self') return null;
    if (!record.financial) return null;
    if (record.lawful_basis === 'special_data_consent') return null;

    return deny(
      'lawful_basis_forbids',
      `${record.type} ${record.id} holds financial information on ${record.lawful_basis}, which s.9(3) does not permit`,
    );
  }

  /**
   * Membership, resolved from the log at each record's `occurred_at`.
   *
   * At `occurred_at` and not at now, because spec §5.4 says a farmer's
   * deliveries three seasons ago remain valid history after they leave. The
   * converse is the point of this method: leaving ends the coop's access to
   * anything that happens afterwards, and a coop cannot reach into a past
   * season by enrolling somebody today.
   */
  private async resolveMembership(
    requester: string,
    request: ConsentRequest,
  ): Promise<Set<string>> {
    const queries: MembershipQuery[] = [];
    for (const record of request.records) {
      if (!record.parties.includes(requester)) continue;
      for (const party of record.parties) {
        if (party !== requester) {
          queries.push({ member: party, at: record.occurred_at });
        }
      }
    }

    return this.repository.activeMemberships(
      requester,
      queries,
      request.dataset,
    );
  }

  /**
   * Kernel integrity work — resolving a supersession chain, checking mass
   * balance, anchoring. These read records without disclosing them to anyone,
   * so there is no subject to obtain consent from.
   *
   * Deliberately not reachable through `decide`: no request input can produce
   * this decision, and no controller constructs one.
   */
  integrity(operation: IntegrityOperation): ConsentDecision {
    return {
      allowed: true,
      reason: 'kernel_integrity',
      detail: `kernel ${operation}, not a disclosure`,
      grants: [],
    };
  }

  /**
   * The guard. A consent failure must never degrade into a partial result, so
   * this throws rather than filtering.
   *
   * NOT THE DISCLOSURE PATH. Nothing that returns records to a caller uses
   * this, and nothing new should: those paths call `decide` and then write an
   * audit entry — for the denial as well as the allowance — before acting on
   * it. `test/invariants/audit.test.ts` fails if a new call site appears.
   */
  async assertPermitted(request: ConsentRequest): Promise<ConsentDecision> {
    const decision = await this.decide(request);
    if (!decision.allowed) throw new ConsentDenied(decision);
    return decision;
  }
}

/**
 * Which class of access this is.
 *
 * The order is not the order of permissiveness. Asserter comes first because
 * you cannot withhold a record from the party that wrote it. Member body comes
 * before self because an organisation reading a record it is merely a
 * counterparty to is exactly the case s.9(3)(c) governs, and letting `self`
 * swallow it would make the flag inert.
 */
export function classify(
  record: RecordFacts,
  requester: string,
  membership: ReadonlySet<string>,
): AccessClass {
  if (record.asserted_by === requester) return 'asserter';

  const party = record.parties.includes(requester);
  if (
    party &&
    record.parties.some(
      (other) =>
        other !== requester &&
        membership.has(membershipKey(other, record.occurred_at)),
    )
  ) {
    return 'member_body';
  }

  return party ? 'self' : 'third_party';
}

export function membershipKey(member: string, at: string): string {
  return `${member}|${new Date(at).toISOString()}`;
}

export interface GrantQuery {
  purpose: ConsentPurpose;
  recordType: string;
  at: string;
}

export type GrantRefusal = Extract<
  ConsentReason,
  | 'no_grant'
  | 'grant_expired'
  | 'grant_revoked'
  | 'grant_wrong_purpose'
  | 'grant_wrong_record_type'
>;

export interface GrantResolution {
  grant: ConsentGrantRow | null;
  reason: GrantRefusal;
  detail: string;
}

/** How specific a refusal is. The most specific one is what gets reported. */
const REFUSAL_RANK: Record<GrantRefusal, number> = {
  no_grant: 0,
  grant_wrong_purpose: 1,
  grant_wrong_record_type: 2,
  grant_expired: 3,
  grant_revoked: 4,
};

/**
 * Resolve one subject's grants against one request, at request time.
 *
 * Purpose is matched exactly and never widened: a grant for credit assessment
 * is not a grant for market intelligence, and "close enough" is how a consent
 * regime becomes a formality.
 *
 * The refusals are distinct because they mean different things to whoever has
 * to act on them. An expired grant is renewable, a revoked one is a decision
 * somebody made, and a wrong-purpose one means the integration is asking for
 * something the subject was never asked about.
 */
export function resolveGrant(
  held: readonly ConsentGrantRow[],
  query: GrantQuery,
): GrantResolution {
  const at = Date.parse(query.at);
  let best: GrantResolution = {
    grant: null,
    reason: 'no_grant',
    detail: 'no grant exists',
  };

  const note = (reason: GrantRefusal, detail: string): void => {
    if (REFUSAL_RANK[reason] >= REFUSAL_RANK[best.reason]) {
      best = { grant: null, reason, detail };
    }
  };

  for (const grant of held) {
    if (grant.purpose !== query.purpose) {
      note(
        'grant_wrong_purpose',
        `the grant covers ${grant.purpose}, not ${query.purpose}`,
      );
      continue;
    }
    if (!grant.record_types.includes(query.recordType)) {
      note(
        'grant_wrong_record_type',
        `the grant does not cover "${query.recordType}"`,
      );
      continue;
    }
    if (grant.revoked_at !== null && Date.parse(grant.revoked_at) <= at) {
      note('grant_revoked', `the grant was withdrawn on ${grant.revoked_at}`);
      continue;
    }
    if (grant.expires_at !== null && Date.parse(grant.expires_at) <= at) {
      note('grant_expired', `the grant expired on ${grant.expires_at}`);
      continue;
    }
    if (Date.parse(grant.granted_at) > at) {
      note('no_grant', 'the grant had not been given yet');
      continue;
    }
    return { grant, reason: 'no_grant', detail: 'granted' };
  }

  return best;
}

function allowedReason(access: AccessClass, usedGrant: boolean): ConsentReason {
  if (access === 'self') return 'self_read';
  if (access === 'asserter') return 'asserter_read';
  if (access === 'member_body') {
    return usedGrant ? 'member_body_with_grant' : 'member_body';
  }
  return 'third_party_with_grant';
}

function detailFor(access: AccessClass, grants: number): string {
  const plural = grants === 1 ? '' : 's';
  const suffix = grants === 0 ? '' : ` on ${grants} grant${plural}`;
  return `released as ${access.replace('_', ' ')}${suffix}`;
}

function deny(reason: ConsentReason, detail: string): ConsentDecision {
  return { allowed: false, reason, detail, grants: [] };
}
