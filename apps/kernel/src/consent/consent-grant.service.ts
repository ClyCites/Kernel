import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { AuditService } from '../audit/audit.service.js';
import type { Dataset } from '../records/record.js';
import {
  ConsentRepository,
  type ConsentGrantRow,
} from './consent.repository.js';
import type { ConsentChannel, ConsentPurpose } from './consent.service.js';

export interface NewGrant {
  subject: string;
  grantee: string;
  purpose: ConsentPurpose;
  recordTypes: string[];
  expiresAt: string | null;
  grantedVia: ConsentChannel;
  evidence: unknown[];
  dataset: Dataset;
  correlationId?: string | null | undefined;
}

/**
 * Writing and withdrawing grants, and showing a subject their own.
 *
 * Only the subject may do any of it. A grantee that could create its own grant
 * would have written itself a permission slip, and a grantee that could read
 * the list could enumerate who else a farmer deals with.
 */
@Injectable()
export class ConsentGrantService {
  constructor(
    @Inject(ConsentRepository) private readonly repository: ConsentRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async grant(grant: NewGrant): Promise<ConsentGrantRow> {
    const row = await this.repository.insertGrant({
      id: uuidv7(),
      subject: grant.subject,
      grantee: grant.grantee,
      purpose: grant.purpose,
      recordTypes: grant.recordTypes,
      grantedAt: new Date().toISOString(),
      expiresAt: grant.expiresAt,
      grantedVia: grant.grantedVia,
      evidence: grant.evidence,
      dataset: grant.dataset,
    });

    await this.audit.record({
      action: 'record.write',
      outcome: 'allowed',
      dataset: grant.dataset,
      reason: 'consent_granted',
      actor: grant.subject,
      purpose: grant.purpose,
      subjects: [grant.subject],
      records: [row.id],
      recordTypes: ['consent_grant'],
      detail: { granted_via: grant.grantedVia, grantee: grant.grantee },
      correlationId: grant.correlationId ?? null,
    });

    return row;
  }

  /** s.10(4). Withdrawal is an insert; the grant row is never touched. */
  async revoke(
    id: string,
    subject: string,
    reason: string | null,
    dataset: Dataset,
    correlationId?: string | null,
  ): Promise<ConsentGrantRow | null> {
    const held = await this.repository.grantsBySubject(subject, dataset);
    const target = held.find((grant) => grant.id === id);
    if (target === undefined) return null;

    const row = await this.repository.revokeGrant(
      id,
      uuidv7(),
      subject,
      new Date().toISOString(),
      reason,
    );

    await this.audit.record({
      action: 'record.write',
      outcome: 'allowed',
      dataset,
      reason: 'consent_revoked',
      actor: subject,
      subjects: [subject],
      records: [id],
      recordTypes: ['consent_grant'],
      detail: { grantee: target.grantee, purpose: target.purpose },
      correlationId: correlationId ?? null,
    });

    return row;
  }

  /**
   * What a subject has permitted. Part of their s.24 subject-access answer: a
   * grant is personal data about the person who gave it, and "who did I say
   * yes to" is one of the few things a farmer will actually want to ask.
   */
  async held(
    subject: string,
    dataset: Dataset,
    correlationId?: string | null,
  ): Promise<ConsentGrantRow[]> {
    const grants = await this.repository.grantsBySubject(subject, dataset);

    await this.audit.record({
      action: 'record.read',
      outcome: 'allowed',
      dataset,
      reason: 'self_read',
      actor: subject,
      subjects: [subject],
      records: grants.map((grant) => grant.id),
      recordTypes: ['consent_grant'],
      detail: { by: 'own_grants', returned: grants.length },
      correlationId: correlationId ?? null,
    });

    return grants;
  }
}
