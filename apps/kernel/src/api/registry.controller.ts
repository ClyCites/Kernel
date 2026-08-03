import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { RegistryRepository } from '../registry/registry.repository.js';
import type { UnitConversionDetail } from '../registry/types.js';

/**
 * Reference data, readable by anyone.
 *
 * Deliberately unauthenticated and outside the consent gate. The registry holds
 * unit conversions, crop codes, boundaries and grading vocabularies — no
 * personal data, no assertions, nothing about any farmer. Gating it would be
 * theatre, and worse than theatre: a lender holding a delivery of `12 bag ->
 * 1200 kg` can only check that claim by dereferencing the factor it cites. If
 * the factor needs a credential, the verification needs our permission, and a
 * record you need our permission to verify is a record you are trusting us for.
 *
 * Every row is immutable and superseded rather than edited, so responses are
 * cacheable for a long time and say so.
 *
 * See docs/decisions/0024-registry-read-api.md.
 */

const MAX_PAGE = 500;

const Limit = z.coerce.number().int().min(1).max(MAX_PAGE).default(100);

const ConversionQuery = z.object({
  from_unit: z.string().min(1).optional(),
  to_unit: z.string().min(1).optional(),
  commodity: z.string().min(1).optional(),
  region_code: z.string().min(1).optional(),
  basis: z.string().min(1).optional(),
  limit: Limit,
});

const ObservationTypeQuery = z.object({
  subject_type: z.string().min(1).optional(),
  limit: Limit,
});

const CropCodeQuery = z.object({
  parent_code: z.string().min(1).optional(),
  limit: Limit,
});

const AdminRegionQuery = z.object({
  vintage: z.string().regex(/^\d{4}$/).optional(),
  level: z.string().min(1).optional(),
  parent_code: z.string().min(1).optional(),
  limit: Limit,
});

const SchemeQuery = z.object({ limit: Limit });

const SeasonQuery = z.object({
  label: z.string().min(1).optional(),
  region_code: z.string().min(1).optional(),
  limit: Limit,
});

const Id = z.uuid();

/** A day. The rows cannot change; only new ones can appear. */
const CACHE_SECONDS = 86_400;

@Controller('v1/registry')
export class RegistryController {
  constructor(
    @Inject(RegistryRepository) private readonly registry: RegistryRepository,
  ) {}

  @Get('conversions')
  async conversions(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const filter = parse(ConversionQuery, query);
    cacheable(response);
    return {
      conversions: await this.registry.listConversions({
        fromUnit: filter.from_unit,
        toUnit: filter.to_unit,
        commodity: filter.commodity,
        regionCode: filter.region_code,
        basis: filter.basis,
        limit: filter.limit,
      }),
    };
  }

  @Get('conversions/:id')
  async conversion(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UnitConversionDetail> {
    const parsed = Id.safeParse(id);
    if (!parsed.success) throw new NotFoundException(`${id} is not a conversion id`);

    const row = await this.registry.conversion(parsed.data);
    if (row === null) throw new NotFoundException(`no conversion ${id}`);

    cacheable(response);
    return { ...row, sample: await this.registry.conversionSample(parsed.data) };
  }

  @Get('observation-types')
  async observationTypes(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const filter = parse(ObservationTypeQuery, query);
    cacheable(response);
    return {
      observation_types: await this.registry.listObservationTypes({
        subjectType: filter.subject_type,
        limit: filter.limit,
      }),
    };
  }

  @Get('observation-types/:code')
  async observationType(
    @Param('code') code: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const entry = await this.registry.observationType(code);
    if (entry === null) throw new NotFoundException(`no observation type ${code}`);
    cacheable(response);
    return entry;
  }

  @Get('crop-codes')
  async cropCodes(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const filter = parse(CropCodeQuery, query);
    cacheable(response);
    return {
      crop_codes: await this.registry.listCropCodes({
        parentCode: filter.parent_code,
        limit: filter.limit,
      }),
    };
  }

  @Get('crop-codes/:code')
  async cropCode(
    @Param('code') code: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const entry = await this.registry.cropCode(code);
    if (entry === null) throw new NotFoundException(`no crop code ${code}`);
    cacheable(response);
    return entry;
  }

  @Get('admin-regions')
  async adminRegions(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const filter = parse(AdminRegionQuery, query);
    cacheable(response);
    return {
      admin_regions: await this.registry.listAdminRegions({
        vintage: filter.vintage,
        level: filter.level,
        parentCode: filter.parent_code,
        limit: filter.limit,
      }),
    };
  }

  /**
   * Keyed on both parts. A district code without its boundary vintage is
   * ambiguous across time (D6), so there is no route that takes a code alone.
   */
  @Get('admin-regions/:code/:vintage')
  async adminRegion(
    @Param('code') code: string,
    @Param('vintage') vintage: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const entry = await this.registry.adminRegion(code, vintage);
    if (entry === null) {
      throw new NotFoundException(`no region ${code} at vintage ${vintage}`);
    }
    cacheable(response);
    return entry;
  }

  /**
   * What a season label covers. Work order M4.
   *
   * Nearly empty on purpose, and visibly so: only what a citation supports is
   * in the table, and a label with no row returns nothing rather than a
   * plausible guess. See docs/data-sources.md.
   */
  @Get('seasons')
  async seasons(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const filter = parse(SeasonQuery, query);
    cacheable(response);
    return {
      seasons: await this.registry.listSeasonCalendar({
        label: filter.label,
        regionCode: filter.region_code,
        limit: filter.limit,
      }),
    };
  }

  /** Most specific region wins: a district row beats the national one. */
  @Get('seasons/:label/:code/:vintage')
  async season(
    @Param('label') label: string,
    @Param('code') code: string,
    @Param('vintage') vintage: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const entry = await this.registry.seasonCalendar({
      label,
      regionCode: code,
      regionVintage: vintage,
    });
    if (entry === null) {
      throw new NotFoundException(
        `no calendar for season ${label} in ${code} at vintage ${vintage}`,
      );
    }
    cacheable(response);
    return entry;
  }

  @Get('grading-schemes')
  async gradingSchemes(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const filter = parse(SchemeQuery, query);
    cacheable(response);
    return { grading_schemes: await this.registry.listGradingSchemes(filter.limit) };
  }

  @Get('grading-schemes/:scheme')
  async gradingScheme(
    @Param('scheme') scheme: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const entry = await this.registry.gradingScheme(scheme);
    if (entry === null) throw new NotFoundException(`no grading scheme ${scheme}`);
    cacheable(response);
    return { ...entry, values: await this.registry.gradingSchemeValues(scheme) };
  }
}

function cacheable(response: Response): void {
  response.setHeader(
    'Cache-Control',
    `public, max-age=${CACHE_SECONDS}, immutable`,
  );
}

function parse<T>(schema: z.ZodType<T>, query: unknown): T {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}
