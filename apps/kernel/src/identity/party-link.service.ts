import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { AuditService } from '../audit/audit.service.js';
import {
  ConsentDenied,
  ConsentService,
  type ConsentPurpose,
} from '../consent/consent.service.js';
import type { Dataset } from '../records/record.js';
import {
  PartyLinkRepository,
  type NewPartyLink,
  type PartyLinkRow,
} from './party-link.repository.js';

/**
 * Identity links, resolved and never collapsed. Work order M3, deferring D2.
 *
 * The rule this service exists to hold: **a resolution returns a set of
 * identities and the links between them, never a canonical id**. Every caller
 * of `resolve` gets enough to merge if it wants to, and nothing that has merged
 * on its behalf. That asymmetry is the whole design — collapsing links into a
 * merge later is a migration anybody can write, and un-merging is archaeology.
 *
 * Consent applies. Asserting that two named people are the same person is
 * processing personal data about both, so both reads and writes here go through
 * the same gate and the same audit entry as a record read.
 */

export interface LinkedIdentity {
  /** The party asked about, first, followed by everything reachable from it. */
  identities: string[];
  links: PartyLinkRow[];
  /**
   * Present so a consumer cannot mistake this for a canonical id. There is no
   * canonical id, and asking for one is the question D2 has not answered.
   */
  collapsed: false;
}

export interface LinkAssertion {
  leftParty: string;
  rightParty: string;
  assertedBy: string;
  confidence: number;
  evidence: string;
  evidenceNote?: string | null | undefined;
  lawfulBasis: string;
  dataset?: Dataset | undefined;
  correlationId?: string | null | undefined;
}

export interface LinkReader {
  requester: string | null;
  purpose?: ConsentPurpose | null | undefined;
  dataset?: Dataset | undefined;
  correlationId?: string | null | undefined;
}

/** A cap on how far a chain of links is walked before it is called a mistake. */
export const MAX_LINK_DEPTH = 8;

@Injectable()
export class PartyLinkService {
  constructor(
    @Inject(PartyLinkRepository) private readonly repository: PartyLinkRepository,
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Everything reachable from a party, transitively.
   *
   * Breadth-first with a depth cap. A link chain longer than `MAX_LINK_DEPTH`
   * is not a person with many aliases, it is a bad matcher that has joined two
   * unrelated clusters, and walking it to the end would return a set that
   * defames everyone in it.
   */
  async resolve(party: string, reader: LinkReader): Promise<LinkedIdentity> {
    const dataset = reader.dataset ?? 'live';
    const identities = [party];
    const seen = new Set(identities);
    const links: PartyLinkRow[] = [];
    const linkIds = new Set<string>();

    let frontier = [party];
    for (let depth = 0; depth < MAX_LINK_DEPTH && frontier.length > 0; depth += 1) {
      const found = await this.repository.touching(frontier, dataset);
      const next: string[] = [];
      for (const link of found) {
        if (!linkIds.has(link.id)) {
          linkIds.add(link.id);
          links.push(link);
        }
        for (const side of [link.left_party, link.right_party]) {
          if (!seen.has(side)) {
            seen.add(side);
            identities.push(side);
            next.push(side);
          }
        }
      }
      frontier = next;
    }

    await this.gate(
      { subjects: identities, asserters: links.map((link) => link.asserted_by) },
      reader,
      'record.read',
      { by: 'party_links', resolved: identities.length, links: links.length },
    );

    return { identities, links, collapsed: false };
  }

  /** Assert that two parties are probably the same. Reversible by design. */
  async assert(assertion: LinkAssertion): Promise<PartyLinkRow> {
    const dataset = assertion.dataset ?? 'live';
    await this.gate(
      {
        subjects: [assertion.leftParty, assertion.rightParty],
        asserters: [assertion.assertedBy],
      },
      {
        requester: assertion.assertedBy,
        dataset,
        correlationId: assertion.correlationId,
      },
      'record.write',
      { by: 'party_link_assert', evidence: assertion.evidence },
    );

    const link: NewPartyLink = {
      id: uuidv7(),
      leftParty: assertion.leftParty,
      rightParty: assertion.rightParty,
      assertedBy: assertion.assertedBy,
      assertedAt: new Date().toISOString(),
      confidence: assertion.confidence,
      evidence: assertion.evidence,
      evidenceNote: assertion.evidenceNote ?? null,
      dataset,
      lawfulBasis: assertion.lawfulBasis,
    };
    return this.repository.insert(link);
  }

  /**
   * Withdraw a link. The row stays and the retraction is recorded on it, so
   * "we thought these were the same person and stopped thinking so" is itself
   * on the record — which is the recoverability the whole shape is for.
   */
  async retract(
    id: string,
    by: string,
    reason: string,
    correlationId?: string | null,
  ): Promise<PartyLinkRow | null> {
    const retracted = await this.repository.retract(id, by, reason);
    await this.audit.record({
      action: 'record.write',
      outcome: 'allowed',
      dataset: retracted?.dataset ?? 'live',
      reason: retracted === null ? 'already_retracted' : 'link_retracted',
      actor: by,
      records: [id],
      recordTypes: ['party_link'],
      detail: { by: 'party_link_retract' },
      correlationId: correlationId ?? null,
    });
    return retracted;
  }

  /**
   * The gate. `decide` then audit then act, in that order and never any other:
   * a denial that is not recorded is a disclosure decision nobody can review.
   */
  private async gate(
    about: { subjects: string[]; asserters: string[] },
    reader: LinkReader,
    action: 'record.read' | 'record.write',
    detail: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const dataset = reader.dataset ?? 'live';
    // A link is presented to the decision point as what it is: a claim about
    // two parties, asserted by somebody. There is no record id yet on a write,
    // so the link's own id stands in.
    const decision = await this.consent.decide({
      records: about.subjects.map((subject) => ({
        id: subject,
        type: 'party_link',
        subjects: about.subjects,
        parties: about.subjects,
        via: null,
        asserted_by: about.asserters[0] ?? (reader.requester ?? subject),
        on_behalf_of: null,
        occurred_at: new Date().toISOString(),
        financial: false,
        lawful_basis: 'contract_performance',
      })),
      requester: reader.requester,
      purpose: reader.purpose ?? null,
      dataset,
      at: new Date().toISOString(),
    });

    await this.audit.record({
      action: decision.allowed ? action : 'consent.denied',
      outcome: decision.allowed ? 'allowed' : 'denied',
      dataset,
      reason: decision.reason,
      actor: reader.requester,
      purpose: reader.purpose ?? null,
      subjects: about.subjects,
      recordTypes: ['party_link'],
      detail,
      correlationId: reader.correlationId ?? null,
    });

    if (!decision.allowed) throw new ConsentDenied(decision);
  }
}
