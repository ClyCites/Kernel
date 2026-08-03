import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import type { Dataset } from '../records/record.js';

/**
 * `same_as` links, as stored. Work order M3, deferring open decision D2.
 *
 * There is no update method beyond `retract`, and there is no delete. See
 * migration 0019 for why the retraction is an UPDATE rather than a second row:
 * withdrawal is a property of the link, not a new claim about the world.
 */

export interface PartyLinkRow {
  id: string;
  relation: 'same_as';
  left_party: string;
  right_party: string;
  asserted_by: string;
  asserted_at: string;
  confidence: number;
  evidence: string;
  evidence_note: string | null;
  dataset: Dataset;
  lawful_basis: string;
  retracted_at: string | null;
  retracted_by: string | null;
  retraction_reason: string | null;
}

export interface NewPartyLink {
  id: string;
  leftParty: string;
  rightParty: string;
  assertedBy: string;
  assertedAt: string;
  confidence: number;
  evidence: string;
  evidenceNote: string | null;
  dataset: Dataset;
  lawfulBasis: string;
}

const COLUMNS = `
  select id, relation, left_party, right_party, asserted_by,
         to_char(asserted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ') as asserted_at,
         confidence::float8 as confidence,
         evidence, evidence_note, dataset, lawful_basis,
         to_char(retracted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ') as retracted_at,
         retracted_by, retraction_reason
    from kernel.party_link
`;

@Injectable()
export class PartyLinkRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  /**
   * The pair is stored in a fixed order so that asserting B~A after A~B
   * collides on the unique index instead of quietly creating a second link.
   */
  async insert(link: NewPartyLink): Promise<PartyLinkRow> {
    const [left, right] =
      link.leftParty < link.rightParty
        ? [link.leftParty, link.rightParty]
        : [link.rightParty, link.leftParty];

    const { rows } = await this.pool.query<PartyLinkRow>(
      `with inserted as (
         insert into kernel.party_link
           (id, relation, left_party, right_party, asserted_by, asserted_at,
            confidence, evidence, evidence_note, dataset, lawful_basis)
         values ($1, 'same_as', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id
       )
       ${COLUMNS} where id = (select id from inserted)`,
      [
        link.id,
        left,
        right,
        link.assertedBy,
        link.assertedAt,
        link.confidence,
        link.evidence,
        link.evidenceNote,
        link.dataset,
        link.lawfulBasis,
      ],
    );
    return rows[0]!;
  }

  async retract(
    id: string,
    by: string,
    reason: string,
  ): Promise<PartyLinkRow | null> {
    const { rows } = await this.pool.query<PartyLinkRow>(
      `with updated as (
         update kernel.party_link
            set retracted_at = now(), retracted_by = $2, retraction_reason = $3
          where id = $1 and retracted_at is null
          returning id
       )
       ${COLUMNS} where id = (select id from updated)`,
      [id, by, reason],
    );
    return rows[0] ?? null;
  }

  /** Live links touching any of these parties. Retracted ones are excluded. */
  async touching(parties: string[], dataset: Dataset): Promise<PartyLinkRow[]> {
    if (parties.length === 0) return [];
    const { rows } = await this.pool.query<PartyLinkRow>(
      `${COLUMNS}
        where dataset = $2
          and retracted_at is null
          and (left_party = any($1::uuid[]) or right_party = any($1::uuid[]))`,
      [parties, dataset],
    );
    return rows;
  }
}
