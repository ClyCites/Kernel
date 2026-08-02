import { Injectable } from '@nestjs/common';

/**
 * PLACEHOLDER. There is no consent implementation in this kernel.
 *
 * See the core-facts spec §10 and open decision D3. Consent under the Data
 * Protection and Privacy Act, 2019 is purpose-bound: a farmer agreeing that a
 * coop may see their deliveries has not agreed that a lender may. Deciding that
 * correctly needs a consent spec, a grant record, and a revocation path, none of
 * which exist yet.
 *
 * This file exists so that their absence fails CLOSED. Without it the default is
 * no check at all, and the first external integration discloses farmer
 * production history with no lawful basis. Every purpose is therefore denied,
 * and only three internal uses are allowed — a subject reading their own
 * records, the party that asserted a record reading it back, and the kernel's
 * own integrity operations.
 *
 * DO NOT relax this to unblock a feature. If an integration needs data out, that
 * is the signal to write the consent spec, not to widen the stub. Only the body
 * of `decide` should ever change; the signature is the one the real
 * implementation needs, so no call site moves when it is replaced.
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

/** Kernel operations that read records without disclosing them to anyone. */
export const INTEGRITY_OPERATIONS = [
  'supersession_resolution',
  'mass_balance',
  'anchoring',
] as const;

export type IntegrityOperation = (typeof INTEGRITY_OPERATIONS)[number];

export type ConsentReason =
  | 'self_read'
  | 'asserter_read'
  | 'kernel_integrity'
  | 'foreign_subject_in_self_read'
  | 'unattributed_record'
  | 'consent_not_implemented';

/** Never a bare boolean: the reason is what goes in the audit log. */
export interface ConsentDecision {
  allowed: boolean;
  reason: ConsentReason;
  detail: string;
}

export interface ConsentRequest {
  /**
   * Every party the records are about, derived from the records themselves via
   * `subjectsOf`. Never taken from the caller — a requester who can name their
   * own subjects has a bypass, not a gate.
   */
  subjects: readonly string[];
  /** `asserted_by` of each record. Also derived, for the same reason. */
  asserters: readonly string[];
  /** The party asking. Null when no verified subject reached the kernel. */
  requester: string | null;
  /** Why the data is wanted. Null only for a party reading their own records. */
  purpose: ConsentPurpose | null;
  record_types: readonly string[];
  at: string;
}

export class ConsentDenied extends Error {
  readonly code = 'consent_denied';

  constructor(readonly decision: ConsentDecision) {
    super(decision.detail);
    this.name = 'ConsentDenied';
  }
}

@Injectable()
export class ConsentService {
  /**
   * The only decision function. Everything that can disclose personal data
   * passes through here.
   */
  decide(request: ConsentRequest): ConsentDecision {
    const subjects = new Set(request.subjects);
    const asserters = new Set(request.asserters);
    const { requester } = request;

    // A record nobody can be identified from cannot be governed: no grant can
    // be resolved against it and no revocation can reach it. Spec §10.
    if (subjects.size === 0) {
      return deny(
        'unattributed_record',
        'the records name no subject, so no consent decision can be resolved against them',
      );
    }

    // Every purpose. There is nothing to evaluate a purpose against yet.
    if (request.purpose !== null) {
      return deny(
        'consent_not_implemented',
        `no consent implementation exists, so no record may be released for ${request.purpose}`,
      );
    }

    if (requester === null) {
      return deny(
        'consent_not_implemented',
        'no verified subject reached the kernel, so no record may be released',
      );
    }

    if (subjects.size === 1 && subjects.has(requester)) {
      return allow('self_read', 'the requester is the only subject');
    }

    if (asserters.size === 1 && asserters.has(requester)) {
      return allow('asserter_read', 'the requester asserted every record');
    }

    // Bundling other parties' records into a "self" read is the obvious bypass,
    // so it is named separately in the audit log rather than folded into the
    // generic denial.
    if (subjects.has(requester)) {
      return deny(
        'foreign_subject_in_self_read',
        'the request is about parties other than the requester',
      );
    }

    return deny(
      'consent_not_implemented',
      'no consent implementation exists, so no record may be released to a third party',
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
    return allow('kernel_integrity', `kernel ${operation}, not a disclosure`);
  }

  /**
   * The guard. A consent failure must never degrade into a partial result, so
   * this throws rather than filtering: half a page of records looks like an
   * answer and is not one.
   */
  assertPermitted(request: ConsentRequest): ConsentDecision {
    const decision = this.decide(request);
    if (!decision.allowed) throw new ConsentDenied(decision);
    return decision;
  }
}

function allow(reason: ConsentReason, detail: string): ConsentDecision {
  return { allowed: true, reason, detail };
}

function deny(reason: ConsentReason, detail: string): ConsentDecision {
  return { allowed: false, reason, detail };
}
