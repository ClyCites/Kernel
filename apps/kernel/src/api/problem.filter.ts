import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ConsentDenied } from '../consent/consent.service.js';
import { QueryRejected, RecordRejected } from '../records/errors.js';
import { CORRELATION_HEADER } from './correlation.middleware.js';

/** Brief §5 phase 4. Errors are RFC 9457 problem details, not ad-hoc JSON. */
interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  correlation_id?: string;
  issues?: Array<{ path: string; message: string }>;
}

const STATUS_BY_CODE: Record<string, number> = {
  malformed_record: 422,
  unknown_record_type: 422,
  supersession_invalid: 422,
  delegation_not_authorised: 403,
  // Not 422. The record is well formed; what is missing or wrong is our
  // authority to hold it, which is the caller's standing, not the payload's.
  lawful_basis_required: 403,
  lawful_basis_insufficient: 403,
  confirmation_not_authorised: 403,
  id_conflict: 409,
  invalid_cursor: 400,
};

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Not authenticated',
  403: 'Not authorised',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable record',
  500: 'Internal error',
  503: 'Not ready',
};

/**
 * The only consent refusals a caller is told the reason for, and what they
 * answer with.
 *
 * Both are about the request rather than about the data: they name no record,
 * no type and no party, so answering them leaks nothing the caller did not
 * already supply. Everything else becomes an indistinguishable 404.
 */
const SAYABLE_REFUSALS: Record<string, number> = {
  purpose_required: 400,
  no_verified_subject: 401,
};

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const problem = this.toProblem(exception);

    problem.instance = request.originalUrl;
    const correlationId = response.getHeader(CORRELATION_HEADER);
    if (typeof correlationId === 'string') problem.correlation_id = correlationId;

    if (problem.status >= 500) {
      // The detail of a 500 is for us, not for the caller.
      this.logger.error(
        `${request.method} ${request.originalUrl} failed`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      delete problem.detail;
    }

    response
      .status(problem.status)
      .type('application/problem+json')
      .json(problem);
  }

  private toProblem(exception: unknown): Problem {
    if (exception instanceof ConsentDenied) {
      // FINDING, fixed here: this used to answer 403 quoting the record id,
      // its type and the party id of whoever's grant was missing. That is a
      // disclosure. It confirms the record exists, says what kind it is, and
      // names a person who asserted something — to a caller established as
      // having no right to any of it.
      //
      // Media has always answered a bare 404 and media was right. So records
      // now do too: no ids, no types, no reason. The reason is written to the
      // audit log by the guard that raised this, which is where a question
      // about a refusal should be answered from.
      if (SAYABLE_REFUSALS[exception.decision.reason] === undefined) {
        return {
          type: '/problems/not_found',
          title: TITLES[404]!,
          status: 404,
          detail: 'no such record, or not yours to read',
        };
      }

      // The exceptions. A caller who stated no purpose, or who reached the
      // kernel with no verified subject, learns nothing about who holds what
      // from being told so — and without being told, a spelling mistake is
      // indistinguishable from having no grant at all.
      const status = SAYABLE_REFUSALS[exception.decision.reason]!;
      return {
        type: `/problems/${exception.decision.reason}`,
        title: TITLES[status] ?? 'Error',
        status,
        detail: exception.decision.detail,
        code: exception.decision.reason,
      };
    }

    if (exception instanceof RecordRejected) {
      const status = STATUS_BY_CODE[exception.code] ?? 422;
      return {
        type: `/problems/${exception.code}`,
        title: TITLES[status] ?? 'Error',
        status,
        detail: exception.message,
        code: exception.code,
        issues: exception.issues,
      };
    }

    if (exception instanceof QueryRejected) {
      const status = STATUS_BY_CODE[exception.code] ?? 400;
      return {
        type: `/problems/${exception.code}`,
        title: TITLES[status] ?? 'Error',
        status,
        detail: exception.message,
        code: exception.code,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: `/problems/${status}`,
        title: TITLES[status] ?? 'Error',
        status,
        detail: exception.message,
      };
    }

    return {
      type: '/problems/internal',
      title: TITLES[500]!,
      status: 500,
      detail: exception instanceof Error ? exception.message : String(exception),
    };
  }
}
