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

    // Written back onto the request as well as the response, so the audit log
    // and the http log agree on one identifier without a request-scoped
    // provider or async-local storage. Sanitised above, so nothing forgeable
    // reaches either.
    request.headers[CORRELATION_HEADER] = correlationId;
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

/**
 * Null when the middleware has not run — a controller reached directly in a
 * unit test, for instance. Never invented here: an id minted at the point of
 * use correlates with nothing and only looks as though it does.
 */
export function correlationOf(request: Request): string | null {
  const value = request.headers[CORRELATION_HEADER];
  const id = Array.isArray(value) ? value[0] : value;
  return id !== undefined && ACCEPTABLE.test(id) ? id : null;
}
