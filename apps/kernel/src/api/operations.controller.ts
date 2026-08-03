import {
  Controller,
  Get,
  Header,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SCHEMA_VERSION } from '@clycites/schema';
import type { Pool } from 'pg';

import { KERNEL_POOL } from '../storage/pool.js';
import { RegistryRepository } from '../registry/registry.repository.js';
import { RecordRepository } from '../records/record.repository.js';

/** Below this many weighed containers, `measured` is one morning's anecdote. */
const THIN_SAMPLE = 10;

@Controller('v1')
export class OperationsController {
  constructor(
    @Inject(KERNEL_POOL) private readonly pool: Pool,
    @Inject(RegistryRepository) private readonly registry: RegistryRepository,
    @Inject(RecordRepository) private readonly records: RecordRepository,
  ) {}

  @Get('health')
  health(): { status: string; schema_version: string } {
    return { status: 'ok', schema_version: SCHEMA_VERSION };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; schema_version: string }> {
    try {
      await this.pool.query('select 1');
    } catch {
      throw new ServiceUnavailableException('the log is not reachable');
    }
    return { status: 'ready', schema_version: SCHEMA_VERSION };
  }

  /**
   * Prometheus text format.
   *
   * One measure, and it is the uncomfortable one: how much of the tonnage the
   * kernel reports in kilograms rests on a factor nobody has verified. A high
   * number is not a bug to be hidden — it is the honest current state of the
   * unit registry, and the thing spec §13's field validation exists to move.
   *
   * Computed on read. If it passes roughly 200ms it becomes a rollup.
   */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    const [byBasis, thinKg, census] = await Promise.all([
      this.registry.tonnageByConversionBasis(),
      this.registry.tonnageOnThinSample(THIN_SAMPLE),
      this.records.lawfulBasisCensus(),
    ]);

    const total = [...byBasis.values()].reduce((sum, kg) => sum + kg, 0);
    const assumed = byBasis.get('assumed_default') ?? 0;

    const lines = [
      '# HELP kernel_normalized_kg_total Normalized mass by the basis of the conversion behind it.',
      '# TYPE kernel_normalized_kg_total gauge',
    ];
    for (const [basis, kg] of [...byBasis].sort()) {
      lines.push(`kernel_normalized_kg_total{basis="${basis}"} ${kg}`);
    }
    lines.push(
      '# HELP kernel_assumed_conversion_share Share of normalized mass resting on an unverified default factor.',
      '# TYPE kernel_assumed_conversion_share gauge',
      `kernel_assumed_conversion_share ${total === 0 ? 0 : assumed / total}`,
      `# HELP kernel_thin_sample_kg_total Normalized mass on a measured factor established from fewer than ${THIN_SAMPLE} containers.`,
      '# TYPE kernel_thin_sample_kg_total gauge',
      `kernel_thin_sample_kg_total ${thinKg}`,
      '# HELP kernel_records_by_lawful_basis Live records by the DPPA ground they were collected under.',
      '# TYPE kernel_records_by_lawful_basis gauge',
    );
    for (const row of [...census].sort(
      (a, b) => a.basis.localeCompare(b.basis) || Number(a.financial) - Number(b.financial),
    )) {
      lines.push(
        `kernel_records_by_lawful_basis{basis="${row.basis}",financial="${row.financial}"} ${row.records}`,
      );
    }

    // s.9(1) prohibits processing financial information outside s.9(3). Ingest
    // refuses it, so this should stay at zero; if it moves, something older or
    // something broken is holding special data on a ground that does not cover
    // it, and that is a compliance incident rather than a slow drift.
    const unlawfulFinancial = census
      .filter((row) => row.financial && row.basis !== 'special_data_consent')
      .reduce((sum, row) => sum + row.records, 0);
    lines.push(
      '# HELP kernel_financial_records_without_special_consent Financial records held on a ground other than s.9(3)(b) consent.',
      '# TYPE kernel_financial_records_without_special_consent gauge',
      `kernel_financial_records_without_special_consent ${unlawfulFinancial}`,
    );

    return `${lines.join('\n')}\n`;
  }
}
