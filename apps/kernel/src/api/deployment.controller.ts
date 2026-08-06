import { Controller, Get, Header, Inject } from '@nestjs/common';
import { SCHEMA_VERSION } from '@clycites/schema';

import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import { buildOpenApiDocument } from './openapi.js';

const openApi = buildOpenApiDocument();

@Controller()
export class DeploymentController {
  constructor(
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'DEPLOYMENT_ENVIRONMENT'>,
  ) {}

  @Get()
  root(): { service: string; environment: string; schema_version: string } {
    return {
      service: 'clycites-kernel',
      environment: this.config.DEPLOYMENT_ENVIRONMENT,
      schema_version: SCHEMA_VERSION,
    };
  }

  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=3600')
  contract(): Record<string, unknown> {
    return openApi;
  }
}