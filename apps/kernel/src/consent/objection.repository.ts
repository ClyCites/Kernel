import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import { containment, subjectFields } from '../records/subjects.js';
import type { Dataset } from '../records/record.js';

export type ObjectionChannel = 'in_person' | 'ussd_confirmation' | 'written';
export type WithdrawalChannel = 'in_person' | 'written';

export interface ObjectionRow {
  id: string;
  subject: string;
  scope: string[] | null;
  lodged_at: string;
  lodged_via: ObjectionChannel;
  lodged_by: string;
  delegation: string | null;
  evidence: unknown[];
  dataset: Dataset;
  withdrawn_at: string | null;
}

export interface NewObjection {
  id: string;
  subject: string;
  scope: string[] | null;
  lodgedAt: string;
  lodgedVia: ObjectionChannel;
  lodgedBy: string;
  delegation: string | null;
  evidence: unknown[];
  dataset: Dataset;
}

export interface BasisCount {
  type: string;
  basis: string;
  records: number;
}

/**
 * Timestamps come back as text. A type that is `string` at compile time and
 * `Date` at runtime is how a comparison silently becomes `NaN`.
 */
const OBJECTION_COLUMNS = `o.id, o.subject, o.scope,
  to_json(o.lodged_at) #>> '{}' as lodged_at,
  o.lodged_via, o.lodged_by, o.delegation, o.evidence, o.dataset,
  to_json(w.withdrawn_at) #>> '{}' as withdrawn_at`;

const FROM_OBJECTION = `from kernel.objection o
  left join kernel.objection_withdrawal w on w.objection_id = o.id`;

@Injectable()
export class ObjectionRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  async insertObjection(objection: NewObjection): Promise<ObjectionRow> {
    const { rows } = await this.pool.query<ObjectionRow>(
      `insert into kernel.objection
         (id, subject, scope, lodged_at, lodged_via, lodged_by, delegation,
          evidence, dataset)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       returning id, subject, scope,
                 to_json(lodged_at) #>> '{}' as lodged_at,
                 lodged_via, lodged_by, delegation, evidence, dataset,
                 null::text as withdrawn_at`,
      [
        objection.id,
        objection.subject,
        objection.scope,
        objection.lodgedAt,
        objection.lodgedVia,
        objection.lodgedBy,
        objection.delegation,
        JSON.stringify(objection.evidence),
        objection.dataset,
      ],
    );

    const row = rows[0];
    if (row === undefined) throw new Error('objection insert returned no row');
    return row;
  }

  async objectionsBySubject(
    subject: string,
    dataset: Dataset,
  ): Promise<ObjectionRow[]> {
    const { rows } = await this.pool.query<ObjectionRow>(
      `select ${OBJECTION_COLUMNS} ${FROM_OBJECTION}
        where o.subject = $1 and o.dataset = $2
        order by o.lodged_at desc`,
      [subject, dataset],
    );
    return rows;
  }

  /**
   * Standing objections for a set of subjects, resolved at request time. The
   * caller still has to check each one against the record's own basis: an
   * objection is not a blanket stop, it is a stop where s.7(2) does not apply.
   */
  async standingFor(
    subjects: readonly string[],
    dataset: Dataset,
  ): Promise<Map<string, ObjectionRow[]>> {
    if (subjects.length === 0) return new Map();

    const { rows } = await this.pool.query<ObjectionRow>(
      `select ${OBJECTION_COLUMNS} ${FROM_OBJECTION}
        where o.subject = any($1::uuid[]) and o.dataset = $2
          and w.withdrawn_at is null`,
      [[...new Set(subjects)], dataset],
    );

    const found = new Map<string, ObjectionRow[]>();
    for (const row of rows) {
      const existing = found.get(row.subject);
      if (existing === undefined) found.set(row.subject, [row]);
      else existing.push(row);
    }
    return found;
  }

  async withdrawObjection(
    id: string,
    withdrawalId: string,
    by: string,
    at: string,
    via: WithdrawalChannel,
    reason: string | null,
  ): Promise<ObjectionRow | null> {
    await this.pool.query(
      `insert into kernel.objection_withdrawal
         (id, objection_id, withdrawn_at, withdrawn_by, withdrawn_via, reason)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (objection_id) do nothing`,
      [withdrawalId, id, at, by, via, reason],
    );

    const { rows } = await this.pool.query<ObjectionRow>(
      `select ${OBJECTION_COLUMNS} ${FROM_OBJECTION} where o.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * What is actually held about this subject, by type and by ground.
   *
   * This is what lets the response enumerate both sets. A subject told "done"
   * while a cooperative carries on under `contract_performance` has been
   * misled, which is worse than a refusal.
   */
  async basisCensusForSubject(
    subject: string,
    dataset: Dataset,
  ): Promise<BasisCount[]> {
    const params: unknown[] = [dataset];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const matches = subjectFields().map((field) =>
      field === 'id'
        ? `r.id = ${bind(subject)}`
        : `r.body @> ${bind(JSON.stringify(containment(field, subject)))}::jsonb`,
    );

    const { rows } = await this.pool.query<{
      type: string;
      basis: string;
      records: string;
    }>(
      `select r.type,
              coalesce(r.lawful_basis, 'unstated') as basis,
              count(*) as records
         from facts.record r
        where r.dataset = $1 and (${matches.join(' or ')})
        group by 1, 2
        order by 1, 2`,
      params,
    );

    return rows.map((row) => ({
      type: row.type,
      basis: row.basis,
      records: Number(row.records),
    }));
  }

  /** Standing objections by scope, for /metrics. */
  async standingCensus(): Promise<Array<{ scope: string; objections: number }>> {
    const { rows } = await this.pool.query<{ scope: string; objections: string }>(
      `select case when o.scope is null then 'all'
                   else array_to_string(o.scope, ',') end as scope,
              count(*) as objections
         from kernel.objection o
         left join kernel.objection_withdrawal w on w.objection_id = o.id
        where o.dataset = 'live' and w.withdrawn_at is null
        group by 1
        order by 1`,
    );
    return rows.map((row) => ({
      scope: row.scope,
      objections: Number(row.objections),
    }));
  }
}
