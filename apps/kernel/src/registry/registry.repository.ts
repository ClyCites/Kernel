import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import type {
  AdminRegionEntry,
  ConversionSample,
  CropCodeEntry,
  GradingSchemeEntry,
  GradingSchemeValue,
  ObservationTypeEntry,
  SeasonCalendarEntry,
  UnitConversionRow,
} from './types.js';

const CONVERSION_COLUMNS = `
  id, from_unit, to_unit, factor::float8 as factor,
  commodity, region_code, region_vintage,
  to_char(valid_from, 'YYYY-MM-DD') as valid_from,
  to_char(valid_to,   'YYYY-MM-DD') as valid_to,
  basis, source, supersedes,
  sample_size,
  sample_min::float8    as sample_min,
  sample_max::float8    as sample_max,
  sample_stddev::float8 as sample_stddev,
  condition, local_label,
  measured_by,
  to_char(measured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ') as measured_at,
  instrument
`;

const SEASON_COLUMNS = `
  select region_code, region_vintage, label,
         to_char(starts_on, 'YYYY-MM-DD') as starts_on,
         to_char(ends_on,   'YYYY-MM-DD') as ends_on,
         basis, source, note
    from registry.season_calendar
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

  /* ── the public surface (work order K) ─────────────────────────────── */

  /** The weighings behind a factor, in the order they were taken. */
  async conversionSample(id: string): Promise<ConversionSample[]> {
    const { rows } = await this.pool.query<ConversionSample>(
      `select ordinal, weight_kg::float8 as weight_kg, condition
         from registry.unit_conversion_sample
        where conversion = $1
        order by ordinal`,
      [id],
    );
    return rows;
  }

  /**
   * Filtered listing. Newest first, because a corrected factor supersedes an
   * older one and the reader almost always wants the current statement.
   */
  async listConversions(filter: {
    fromUnit?: string | undefined;
    toUnit?: string | undefined;
    commodity?: string | undefined;
    regionCode?: string | undefined;
    basis?: string | undefined;
    limit: number;
  }): Promise<UnitConversionRow[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    const bind = (value: unknown): string => `$${params.push(value)}`;

    if (filter.fromUnit) where.push(`from_unit = ${bind(filter.fromUnit)}`);
    if (filter.toUnit) where.push(`to_unit = ${bind(filter.toUnit)}`);
    if (filter.commodity) where.push(`commodity = ${bind(filter.commodity)}`);
    if (filter.regionCode) where.push(`region_code = ${bind(filter.regionCode)}`);
    if (filter.basis) where.push(`basis = ${bind(filter.basis)}`);

    const { rows } = await this.pool.query<UnitConversionRow>(
      `select ${CONVERSION_COLUMNS}
         from registry.unit_conversion
        ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
        order by created_at desc, id
        limit ${bind(filter.limit)}`,
      params,
    );
    return rows;
  }

  async listObservationTypes(filter: {
    subjectType?: string | undefined;
    limit: number;
  }): Promise<ObservationTypeEntry[]> {
    const params: unknown[] = [filter.limit];
    const where =
      filter.subjectType === undefined
        ? ''
        : `where $${params.push(filter.subjectType)} = any(subject_types)`;

    const { rows } = await this.pool.query<ObservationTypeEntry>(
      `select code, version, label, unit, value_kind,
              permitted_methods, subject_types, owner, source
         from registry.observation_type
        ${where}
        order by code, version desc
        limit $1`,
      params,
    );
    return rows;
  }

  async cropCode(code: string): Promise<CropCodeEntry | null> {
    const { rows } = await this.pool.query<CropCodeEntry>(
      `select code, label, parent_code, external_scheme, external_code
         from registry.crop_code where code = $1`,
      [code],
    );
    return rows[0] ?? null;
  }

  async listCropCodes(filter: {
    parentCode?: string | undefined;
    limit: number;
  }): Promise<CropCodeEntry[]> {
    const params: unknown[] = [filter.limit];
    const where =
      filter.parentCode === undefined
        ? ''
        : `where parent_code = $${params.push(filter.parentCode)}`;

    const { rows } = await this.pool.query<CropCodeEntry>(
      `select code, label, parent_code, external_scheme, external_code
         from registry.crop_code
        ${where}
        order by code
        limit $1`,
      params,
    );
    return rows;
  }

  async adminRegion(
    code: string,
    vintage: string,
  ): Promise<AdminRegionEntry | null> {
    const { rows } = await this.pool.query<AdminRegionEntry>(
      `select code, vintage, name, level, parent_code, parent_vintage, source
         from registry.admin_region where code = $1 and vintage = $2`,
      [code, vintage],
    );
    return rows[0] ?? null;
  }

  async listAdminRegions(filter: {
    vintage?: string | undefined;
    level?: string | undefined;
    parentCode?: string | undefined;
    limit: number;
  }): Promise<AdminRegionEntry[]> {
    const params: unknown[] = [filter.limit];
    const where: string[] = [];
    if (filter.vintage) where.push(`vintage = $${params.push(filter.vintage)}`);
    if (filter.level) where.push(`level = $${params.push(filter.level)}`);
    if (filter.parentCode) {
      where.push(`parent_code = $${params.push(filter.parentCode)}`);
    }

    const { rows } = await this.pool.query<AdminRegionEntry>(
      `select code, vintage, name, level, parent_code, parent_vintage, source
         from registry.admin_region
        ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
        order by code, vintage desc
        limit $1`,
      params,
    );
    return rows;
  }

  /**
   * What a season label covers, most specific region first. Work order M4.
   *
   * A district row beats the national one, and a lookup that finds neither
   * returns null rather than a plausible guess — an unresolvable season label
   * is the honest answer while the calendar is nearly empty.
   */
  async seasonCalendar(criteria: {
    label: string;
    regionCode: string;
    regionVintage: string;
  }): Promise<SeasonCalendarEntry | null> {
    const { rows } = await this.pool.query<SeasonCalendarEntry>(
      `${SEASON_COLUMNS}
        where label = $1
          and region_vintage = $3
          and $2 like region_code || '%'
        order by length(region_code) desc
        limit 1`,
      [criteria.label, criteria.regionCode, criteria.regionVintage],
    );
    return rows[0] ?? null;
  }

  async listSeasonCalendar(filter: {
    label?: string | undefined;
    regionCode?: string | undefined;
    limit: number;
  }): Promise<SeasonCalendarEntry[]> {
    const params: unknown[] = [filter.limit];
    const where: string[] = [];
    if (filter.label) where.push(`label = $${params.push(filter.label)}`);
    if (filter.regionCode) {
      where.push(`region_code = $${params.push(filter.regionCode)}`);
    }

    const { rows } = await this.pool.query<SeasonCalendarEntry>(
      `${SEASON_COLUMNS}
        ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
        order by label desc, region_code
        limit $1`,
      params,
    );
    return rows;
  }

  async listGradingSchemes(limit: number): Promise<GradingSchemeEntry[]> {
    const { rows } = await this.pool.query<GradingSchemeEntry>(
      `select scheme, label, owner, source
         from registry.grading_scheme order by scheme limit $1`,
      [limit],
    );
    return rows;
  }

  async gradingSchemeValues(scheme: string): Promise<GradingSchemeValue[]> {
    const { rows } = await this.pool.query<GradingSchemeValue>(
      `select scheme, value, label, ordinal
         from registry.grading_scheme_value
        where scheme = $1
        order by ordinal nulls last, value`,
      [scheme],
    );
    return rows;
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

  /**
   * Normalized tonnage resting on a factor that claims measurement but was
   * established from fewer than `minimumSample` containers.
   *
   * `assumed_default` is already visible in the gauge above. This one catches
   * the subtler case: a factor labelled `measured`, which reads as trustworthy,
   * that came from one morning in one store. The field exercise will produce
   * exactly such factors, and they will be believed unless counted.
   */
  async tonnageOnThinSample(minimumSample: number): Promise<number> {
    const { rows } = await this.pool.query<{ kg: number | null }>(
      `select sum((q ->> 'normalized_kg')::numeric)::float8 as kg
         from facts.record r
         cross join lateral jsonb_path_query(r.body, '$.**') q
         join registry.unit_conversion uc
           on uc.id = nullif(q ->> 'conversion_id', '')::uuid
        where jsonb_typeof(q) = 'object'
          and q ? 'raw_value'
          and jsonb_typeof(q -> 'normalized_kg') = 'number'
          and r.dataset = 'live'
          and uc.basis = 'measured'
          and uc.sample_size is not null
          and uc.sample_size < $1
          and not exists (
                select 1 from facts.record s
                 where s.supersedes = r.id
                   and s.dataset = r.dataset)
          and not exists (
                select 1 from facts.record t
                 where t.type = 'retraction'
                   and t.body ->> 'target' = r.id::text
                   and t.dataset = r.dataset)`,
      [minimumSample],
    );
    return rows[0]?.kg ?? 0;
  }
}
