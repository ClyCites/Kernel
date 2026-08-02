import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

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
  id_conflict: 409,
  invalid_cursor: 400,
};

const TITLES: Record<number, string> = {
  400: 'Bad request',
  403: 'Not authorised',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable record',
  500: 'Internal error',
  503: 'Not ready',
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
