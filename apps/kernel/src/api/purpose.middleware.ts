import { BadRequestException, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * The purpose of a read is a query parameter, not a header.
 *
 * FINDING, fixed here: both spellings looked plausible and only one worked. A
 * caller sending the header got its request treated as having stated no
 * purpose at all, and the refusal that followed described a consent problem
 * rather than the spelling mistake that caused it.
 *
 * Query parameter and not header because a purpose is part of what is being
 * asked, not how it is transported: it belongs in the URL that appears in the
 * access log and in the disclosure record, next to the record ids it justifies.
 *
 * So the header is now an error rather than a subtly different request.
 */
export const PURPOSE_HEADER = 'x-clycites-purpose';

@Injectable()
export class PurposeHeaderMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    const claim = request.header(PURPOSE_HEADER);
    if (claim !== undefined) {
      throw new BadRequestException(
        `${PURPOSE_HEADER} is not a header the kernel reads — send purpose as a query parameter, for example ?purpose=${encodeURIComponent(claim)}`,
      );
    }
    next();
  }
}
