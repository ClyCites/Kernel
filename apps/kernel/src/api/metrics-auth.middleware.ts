import {
  Inject,
  Injectable,
  NotFoundException,
  type NestMiddleware,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

@Injectable()
export class MetricsAuthMiddleware implements NestMiddleware {
  constructor(
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'METRICS_BASIC_AUTH'>,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const credential = this.config.METRICS_BASIC_AUTH;
    if (credential === undefined) throw new NotFoundException();

    const supplied = Buffer.from(request.header('authorization') ?? '');
    const expected = Buffer.from(`Basic ${Buffer.from(credential).toString('base64')}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.setHeader('WWW-Authenticate', 'Basic realm="kernel-metrics"');
      response.status(401).end();
      return;
    }

    next();
  }
}