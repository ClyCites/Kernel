import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';

export const CORRELATION_HEADER = 'x-correlation-id';

/** A caller-supplied id is echoed only if it looks like one; otherwise it is
 * a way to forge log lines. */
const ACCEPTABLE = /^[A-Za-z0-9._-]{1,128}$/;

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  private readonly logger = new Logger('http');

  use(request: Request, response: Response, next: NextFunction): void {
    const supplied = request.header(CORRELATION_HEADER);
    const correlationId =
      supplied !== undefined && ACCEPTABLE.test(supplied) ? supplied : uuidv7();

    response.setHeader(CORRELATION_HEADER, correlationId);

    const started = process.hrtime.bigint();
    response.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1_000_000;
      this.logger.log(
        `${correlationId} ${request.method} ${request.originalUrl} ${response.statusCode} ${ms.toFixed(1)}ms`,
      );
    });

    next();
  }
}
