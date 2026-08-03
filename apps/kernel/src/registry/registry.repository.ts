import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import type {
  GradingSchemeEntry,
  ObservationTypeEntry,
  UnitConversionRow,
} from './types.js';

const CONVERSION_COLUMNS = `
  id, from_unit, to_unit, factor::float8 as factor,
  commodity, region_code, region_vintage,
  to_char(valid_from, 'YYYY-MM-DD') as valid_from,
  to_char(valid_to,   'YYYY-MM-DD') as valid_to,
  basis, source, supersedes
`;

/**
 * Read access to reference data. Insert and update are absent by design: the
 * application role holds SELECT only, so there is nothing here that could
 * write even if someone added a method for it.
 */
@Injectable()
export class RegistryRepository {
  constructor(@Inject(KERNEL_POOL) private readonly pool: Pool) {}

  async conversion(id: string): Promise<UnitConversionRow | null> {
    const { rows } = await this.pool.query<UnitConversionRow>(
      `select ${CONVERSION_COLUMNS} from registry.unit_conversion where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Several ids in one round trip — a record can carry many quantities. */
  async conversions(ids: string[]): Promise<Map<string, UnitConversionRow>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool.query<UnitConversionRow>(
      `select ${CONVERSION_COLUMNS}
         from registry.unit_conversion where id = any($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * The conversion the kernel would pick for this unit, commodity, region and
   * date. Most specific wins: a factor scoped to a region beats a national one,
   * and a factor scoped to a commodity beats one that applies to anything.
   */
  async resolveFor(criteria: {
    fromUnit: string;
    commodity: string | null;
    regionCode: string | null;
    regionVintage: string | null;
    on: string;
  }): Promise<UnitConversionRow | null> {
    const { rows } = await this.pool.query<UnitConversionRow>(
      `select ${CONVERSION_COLUMNS}
         from registry.unit_conversion
        where from_unit = $1
          and to_unit = 'kg'
          and (commodity is null or commodity = $2)
          and (region_code is null
               or (region_code = $3 and region_vintage = $4))
          and (valid_from is null or valid_from <= $5::date)
          and (valid_to   is null or valid_to   >= $5::date)
        order by (region_code is not null) desc,
                 (commodity is not null) desc,
                 created_at desc
        limit 1`,
      [
        criteria.fromUnit,
        criteria.commodity,
        criteria.regionCode,
        criteria.regionVintage,
        criteria.on,
      ],
    );
    return rows[0] ?? null;
  }

  /** The current version of an observation type, or null if unregistered. */
  async observationType(code: string): Promise<ObservationTypeEntry | null> {
    const { rows } = await this.pool.query<ObservationTypeEntry>(
      `select code, version, label, unit, value_kind,
              permitted_methods, subject_types, owner, source
         from registry.observation_type
        where code = $1
        order by version desc
        limit 1`,
      [code],
    );
    return rows[0] ?? null;
  }

  async gradingScheme(scheme: string): Promise<GradingSchemeEntry | null> {
    const { rows } = await this.pool.query<GradingSchemeEntry>(
      `select scheme, label, owner, source
         from registry.grading_scheme where scheme = $1`,
      [scheme],
    );
    return rows[0] ?? null;
  }

  async gradeIsInScheme(scheme: string, value: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `select 1 from registry.grading_scheme_value
        where scheme = $1 and value = $2`,
      [scheme, value],
    );
    return rows.length > 0;
  }

  async cropCodeExists(code: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'select 1 from registry.crop_code where code = $1',
      [code],
    );
    return rows.length > 0;
  }

  async adminRegionExists(code: string, vintage: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'select 1 from registry.admin_region where code = $1 and vintage = $2',
      [code, vintage],
    );
    return rows.length > 0;
  }

  /**
   * Normalized tonnage grouped by the basis of the conversion behind it.
   *
   * Computed on read. There are no records yet; if this passes roughly 200ms it
   * becomes a rollup, and not before. `$.**` walks the body because quantities
   * nest at different depths per entity.
   *
   * Superseded and retracted records are excluded — the question is how much of
   * the tonnage *in use* rests on a guess, not how much was ever appended.
   *
   * Live records only, and no parameter to say otherwise. Seed tonnage is
   * fabricated by construction; letting it into an operational gauge would mean
   * the number an operator watches to decide whether the conversion registry is
   * trustworthy is partly made up.
   */
  async tonnageByConversionBasis(): Promise<Map<string, number>> {
    const { rows } = await this.pool.query<{ basis: string; kg: number }>(
      `select coalesce(uc.basis, 'unresolved') as basis,
              sum((q ->> 'normalized_kg')::numeric)::float8 as kg
         from facts.record r
         cross join lateral jsonb_path_query(r.body, '$.**') q
         left join registry.unit_conversion uc
                on uc.id = nullif(q ->> 'conversion_id', '')::uuid
        where jsonb_typeof(q) = 'object'
          and q ? 'raw_value'
          and jsonb_typeof(q -> 'normalized_kg') = 'number'
          and r.dataset = 'live'
          and not exists (
                select 1 from facts.record s
                 where s.supersedes = r.id
                   and s.dataset = r.dataset)
          and not exists (
                select 1 from facts.record t
                 where t.type = 'retraction'
                   and t.body ->> 'target' = r.id::text
                   and t.dataset = r.dataset)
        group by 1`,
    );
    return new Map(rows.map((row) => [row.basis, row.kg]));
  }
}
