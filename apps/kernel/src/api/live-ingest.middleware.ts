import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import { requestedDataset } from './dataset.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class LiveIngestMiddleware implements NestMiddleware {
  constructor(
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<
      KernelConfig,
      'LIVE_INGEST_ENABLED' | 'SEED_INGEST_ENABLED'
    >,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (
      !READ_METHODS.has(request.method) &&
      !this.config.LIVE_INGEST_ENABLED &&
      requestedDataset(request, this.config.SEED_INGEST_ENABLED) === 'live'
    ) {
      response.setHeader('X-Live-Ingest-Disabled', 'true');
      throw new ServiceUnavailableException('live-dataset writes are disabled');
    }

    next();
  }
}