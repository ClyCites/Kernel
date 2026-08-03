import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import type { Dataset } from '../records/record.js';

export interface ConsentGrantRow {
  id: string;
  subject: string;
  grantee: string;
  purpose: string;
  record_types: string[];
  granted_at: string;
  expires_at: string | null;
  granted_via: string;
  evidence: unknown[];
  dataset: Dataset;
  /** Null while the grant stands. Resolved at request time, not at grant time. */
  revoked_at: string | null;
}

export interface NewConsentGrant {
  id: string;
  subject: string;
  grantee: string;
  purpose: string;
  recordTypes: string[];
  grantedAt: string;
  expiresAt: string | null;
  grantedVia: string;
  evidence: unknown[];
  dataset: Dataset;
}

/** One (member, moment) pair to test membership at. */
export interface MembershipQuery {
  member: string;
  at: string;
}

/**
 * Timestamps come back as ISO strings, not `Date`.
 *
 * `to_json(x) #>> '{}'` is the shortest way to say that. It matters because the
 * decision point compares a grant's expiry against the request time, and a
 * driver-parsed `Date` silently reaches that comparison as `NaN` — which is
 * `false` every way round, so an expired grant would read as live.
 */
const GRANT_COLUMNS = `
  select g.id, g.subject, g.grantee, g.purpose, g.record_types,
         to_json(g.granted_at) #>> '{}' as granted_at,
         to_json(g.expires_at) #>> '{}' as expires_at,
         g.granted_via, g.evidence, g.dataset,
         to_json(r.revoked_at) #>> '{}' as revoked_at
    from kernel.consent_grant g
    left join kernel.consent_revocation r on r.grant_id = g.id
`;

/**
 * Membership is resolved from the log, never from the request. A caller
 * asserting "I am their cooperative" is a bypass, not a claim.
 *
 * Superseded and retracted memberships do not count, and the window is
 * inclusive of both ends: a farmer who joined on the day of the delivery was a
 * member for it, and one who left that day still was.
 */
const ACTIVE_MEMBERSHIP = `
  exists (
    select 1 from facts.record m
     where m.type = 'membership'
       and m.dataset = $3
       and m.body ->> 'organisation' = $1
       and m.body ->> 'member' = q.member::text
       and coalesce((m.body ->> 'joined_at')::date, '-infinity'::date) <= q.at::date
       and coalesce((m.body ->> 'left_at')::date, 'infinity'::date) >= q.at::date
       and not exists (
         select 1 from facts.record s
          where s.supersedes = m.id and s.dataset = m.dataset
       )
       and not exists (
         select 1 from facts.record t
          where t.type = 'retraction'
            and t.body ->> 'target' = m.id::text
            and t.dataset = m.dataset
       )
  )
`;

@Injectable()
export class ConsentRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  /**
   * Which of these parties held an active membership in `organisation` at the
   * moment given. One query for the whole page rather than one per record.
   *
   * The key of the returned set is `member|at`, because the answer is
   * time-dependent: the same farmer can be a member for last season's delivery
   * and not for this one.
   */
  async activeMemberships(
    organisation: string,
    queries: readonly MembershipQuery[],
    dataset: Dataset,
  ): Promise<Set<string>> {
    if (queries.length === 0) return new Set();

    const { rows } = await this.pool.query<{ member: string; at: string }>(
      `select q.member::text as member, to_json(q.at) #>> '{}' as at
         from unnest($2::uuid[], $4::timestamptz[]) as q(member, at)
        where ${ACTIVE_MEMBERSHIP}`,
      [
        organisation,
        queries.map((query) => query.member),
        dataset,
        queries.map((query) => query.at),
      ],
    );

    return new Set(
      rows.map((row) => `${row.member}|${new Date(row.at).toISOString()}`),
    );
  }

  /** Every grant this grantee holds over these subjects, revoked or not. */
  async grantsFor(
    grantee: string,
    subjects: readonly string[],
    dataset: Dataset,
  ): Promise<ConsentGrantRow[]> {
    if (subjects.length === 0) return [];

    const { rows } = await this.pool.query<ConsentGrantRow>(
      `${GRANT_COLUMNS}
        where g.grantee = $1
          and g.subject = any($2::uuid[])
          and g.dataset = $3
        order by g.granted_at desc`,
      [grantee, subjects, dataset],
    );
    return rows;
  }

  /**
   * Every grant a subject has given. A grant is personal data about the
   * subject, so it belongs in their subject-access response.
   */
  async grantsBySubject(
    subject: string,
    dataset: Dataset,
  ): Promise<ConsentGrantRow[]> {
    const { rows } = await this.pool.query<ConsentGrantRow>(
      `${GRANT_COLUMNS}
        where g.subject = $1 and g.dataset = $2
        order by g.granted_at desc`,
      [subject, dataset],
    );
    return rows;
  }

  /**
   * `returning` rather than a re-select, because a data-modifying CTE is not
   * visible to the reading half of the same statement: the join would come
   * back empty. `revoked_at` is null by construction — a grant cannot be
   * withdrawn before it exists.
   */
  async insertGrant(grant: NewConsentGrant): Promise<ConsentGrantRow> {
    const { rows } = await this.pool.query<ConsentGrantRow>(
      `insert into kernel.consent_grant
         (id, subject, grantee, purpose, record_types, granted_at,
          expires_at, granted_via, evidence, dataset)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       returning id, subject, grantee, purpose, record_types,
                 to_json(granted_at) #>> '{}' as granted_at,
                 to_json(expires_at) #>> '{}' as expires_at,
                 granted_via, evidence, dataset,
                 null::text as revoked_at`,
      [
        grant.id,
        grant.subject,
        grant.grantee,
        grant.purpose,
        grant.recordTypes,
        grant.grantedAt,
        grant.expiresAt,
        grant.grantedVia,
        JSON.stringify(grant.evidence),
        grant.dataset,
      ],
    );
    return rows[0]!;
  }

  /**
   * Withdraw a grant. Inserts; never updates. A second withdrawal collides on
   * `consent_revocation_once` and returns the grant unchanged, so a retry is
   * not a way to pad the history.
   */
  async revokeGrant(
    id: string,
    revocationId: string,
    by: string,
    at: string,
    reason: string | null,
  ): Promise<ConsentGrantRow | null> {
    await this.pool.query(
      `insert into kernel.consent_revocation
         (id, grant_id, revoked_at, revoked_by, reason)
       values ($1, $2, $3, $4, $5)
       on conflict (grant_id) do nothing`,
      [revocationId, id, at, by, reason],
    );

    const { rows } = await this.pool.query<ConsentGrantRow>(
      `${GRANT_COLUMNS} where g.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }
}
