import createClient, { type Middleware } from 'openapi-fetch';

import { API_VERSION, type paths } from './generated.js';

export { API_VERSION };

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  correlation_id?: string;
  issues?: Array<{ path: string; message: string }>;
}

export class ProblemError extends Error {
  constructor(
    readonly problem: ProblemDetails,
    readonly correlationId: string | null,
  ) {
    super(problem.detail ?? problem.title);
    this.name = 'ProblemError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  actingFor?: string;
  accessToken?: () => string | null;
  correlationId?: () => string;
  fetch?: typeof globalThis.fetch;
}

export class ApiClient {
  readonly api;

  constructor(options: ApiClientOptions) {
    this.api = createClient<paths>({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
    });

    const middleware: Middleware = {
      onRequest({ request }) {
        const accessToken = options.accessToken?.();
        if (accessToken != null) {
          request.headers.set('Authorization', `Bearer ${accessToken}`);
        }
        if (options.actingFor !== undefined) {
          request.headers.set('X-Acting-For', options.actingFor);
        }
        if (options.correlationId !== undefined) {
          request.headers.set('X-Correlation-Id', options.correlationId());
        }
        return request;
      },
      async onResponse({ response }) {
        if (response.ok) return response;
        const correlationId = response.headers.get('X-Correlation-Id');
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/problem+json')) {
          const problem = (await response.clone().json()) as ProblemDetails;
          throw new ProblemError(problem, correlationId);
        }
        return response;
      },
    };
    this.api.use(middleware);
  }
}