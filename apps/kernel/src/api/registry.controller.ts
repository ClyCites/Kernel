import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { SCHEMA_VERSION } from '@clycites/schema';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { RegistryRepository } from '../registry/registry.repository.js';
import type {
  RegistryMetadata,
  UnitConversionDetail,
  UnitConversionRow,
} from '../registry/types.js';
import { RegistryCacheInterceptor, cacheable } from './registry-cache.interceptor.js';
import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

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

const DATASET_LICENSE = 'https://creativecommons.org/publicdomain/zero/1.0/';
const UNCERTAINTY_NOTICE =
  'Most conversion factors are currently assumptions, not field measurements. ' +
  'Use basis and sample provenance to decide what each factor supports.';

@Controller('v1/registry')
@UseInterceptors(RegistryCacheInterceptor)
export class RegistryController {
  constructor(
    @Inject(RegistryRepository) private readonly registry: RegistryRepository,
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'PUBLIC_BASE_URL'>,
  ) {}

  @Get('conversions')
  async conversions(
    @Query() query: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const filter = parse(ConversionQuery, query);
    cacheable(response);
    const [conversions, metadata] = await Promise.all([
      this.registry.listConversions({
        fromUnit: filter.from_unit,
        toUnit: filter.to_unit,
        commodity: filter.commodity,
        regionCode: filter.region_code,
        basis: filter.basis,
        limit: filter.limit,
      }),
      this.registry.metadata(),
    ]);
    return {
      ...this.datasetSummary(metadata, request),
      conversions: conversions.map((row) => this.citable(row, metadata, request)),
    };
  }

  @Get('conversions.json')
  async conversionsJson(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    cacheable(response);
    const { conversions, metadata } = await this.catalogue();
    return {
      ...this.datasetSummary(metadata, request),
      conversions: conversions.map((row) => this.citable(row, metadata, request)),
    };
  }

  @Get('conversions.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async conversionsCsv(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    cacheable(response);
    const { conversions, metadata } = await this.catalogue();
    const columns = [
      'id', 'permanent_url', 'citation', 'from_unit', 'to_unit', 'factor',
      'commodity', 'region_code', 'region_vintage', 'valid_from', 'valid_to',
      'basis', 'source', 'supersedes', 'sample_size', 'sample_min', 'sample_max',
      'sample_stddev', 'condition', 'local_label', 'measured_by', 'measured_at',
      'instrument', 'sample_json',
    ];
    const lines = [columns.join(',')];
    for (const row of conversions) {
      const citable = this.citable(row, metadata, request);
      const values: Record<string, unknown> = {
        ...citable,
        sample_json: JSON.stringify(row.sample),
      };
      lines.push(columns.map((column) => csv(values[column])).join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  @Get('dataset.json')
  async dataset(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    cacheable(response);
    const metadata = await this.registry.metadata();
    const origin = this.origin(request);
    return {
      '@context': {
        dcat: 'http://www.w3.org/ns/dcat#',
        dct: 'http://purl.org/dc/terms/',
      },
      '@id': `${origin}/v1/registry/dataset.json`,
      '@type': 'dcat:Dataset',
      'dct:title': 'ClyCites Ugandan Agricultural Conversion Registry',
      'dct:description': UNCERTAINTY_NOTICE,
      'dct:license': DATASET_LICENSE,
      'dct:modified': metadata.as_at,
      'dct:identifier': `clycites-conversions-${SCHEMA_VERSION}`,
      'dcat:landingPage': `${origin}/v1/registry/conversions`,
      'dcat:distribution': [
        {
          '@type': 'dcat:Distribution',
          'dcat:accessURL': `${origin}/v1/registry/conversions.json`,
          'dct:format': 'application/json',
        },
        {
          '@type': 'dcat:Distribution',
          'dcat:accessURL': `${origin}/v1/registry/conversions.csv`,
          'dct:format': 'text/csv',
        },
      ],
      basis_counts: metadata.basis_counts,
      citation: this.datasetCitation(metadata),
    };
  }

  @Get('conversions/:id')
  async conversion(
    @Param('id') id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const parsed = Id.safeParse(id);
    if (!parsed.success) throw new NotFoundException(`${id} is not a conversion id`);

    const row = await this.registry.conversion(parsed.data);
    if (row === null) throw new NotFoundException(`no conversion ${id}`);

    const metadata = await this.registry.metadata();
    cacheable(response);
    return this.citable(
      { ...row, sample: await this.registry.conversionSample(parsed.data) },
      metadata,
      request,
    );
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

  @Get('crops')
  async crops(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.cropCodes(query, response);
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

  @Get('regions')
  async regions(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.adminRegions(query, response);
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

  private async catalogue(): Promise<{
    conversions: UnitConversionDetail[];
    metadata: RegistryMetadata;
  }> {
    const [rows, metadata] = await Promise.all([
      this.registry.allConversions(),
      this.registry.metadata(),
    ]);
    const samples = await this.registry.conversionSamples(rows.map((row) => row.id));
    return {
      metadata,
      conversions: rows.map((row) => ({
        ...row,
        sample: samples.get(row.id) ?? [],
      })),
    };
  }

  private citable<T extends UnitConversionRow>(
    row: T,
    metadata: RegistryMetadata,
    request: Request,
  ): T & { permanent_url: string; citation: string } {
    const permanentUrl = `${this.origin(request)}/v1/registry/conversions/${row.id}`;
    return {
      ...row,
      permanent_url: permanentUrl,
      citation:
        `ClyCites Ugandan Agricultural Conversion Registry ${SCHEMA_VERSION}, ` +
        `${row.id}, as at ${metadata.as_at}. ${permanentUrl}`,
    };
  }

  private datasetSummary(metadata: RegistryMetadata, request: Request): object {
    return {
      version: SCHEMA_VERSION,
      as_at: metadata.as_at,
      license: DATASET_LICENSE,
      citation: this.datasetCitation(metadata),
      uncertainty_notice: UNCERTAINTY_NOTICE,
      basis_counts: metadata.basis_counts,
      total_conversions: metadata.conversions,
      dataset: `${this.origin(request)}/v1/registry/dataset.json`,
    };
  }

  private datasetCitation(metadata: RegistryMetadata): string {
    return (
      `ClyCites Ugandan Agricultural Conversion Registry ${SCHEMA_VERSION}, ` +
      `as at ${metadata.as_at}, CC0 1.0.`
    );
  }

  private origin(request: Request): string {
    return (
      this.config.PUBLIC_BASE_URL?.replace(/\/$/u, '') ??
      `${request.protocol}://${request.get('host')}`
    );
  }
}

function csv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
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
