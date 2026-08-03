import { createHash } from 'node:crypto';

import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, of, tap } from 'rxjs';

import { KERNEL_CONFIG, type KernelConfig } from '../config.js';

/**
 * An in-process cache in front of the registry, and an ETag on the way out.
 *
 * The cheapest rate limit is not serving the request. The registry is the only
 * anonymous surface in the kernel — see docs/decisions/0024 — and every row it
 * returns is immutable, enforced by the `refuse_mutation` triggers 0009 put on
 * every table there. A row that cannot change is a response that cannot go
 * stale, so an unauthenticated scraper should cost a map lookup rather than a
 * connection from the pool.
 *
 * Two layers, and they do different work:
 *
 * - The cache spares the *database*. A repeat request inside the TTL never
 *   reaches Postgres.
 * - The ETag spares the *network*. A client that already holds the answer gets
 *   304 and no body, which matters on the connections these clients have.
 *
 * The rate limiter still counts a cached hit. That is deliberate: a limiter
 * that only counts expensive requests can be defeated by making cheap ones,
 * and the limit exists to bound traffic as well as load.
 *
 * FINDING, the same one the limiter carries. This is per replica. Behind N
 * instances there are N caches, each independently correct and independently
 * cold after a deploy. Fine for a single-instance kernel behind a gateway;
 * when the gateway grows a shared cache this becomes the second line.
 *
 * Only ever applied to the registry controller. Nothing else in the kernel is
 * safe to cache: every other route is consent-dependent and its correct answer
 * differs per caller, so a URL-keyed cache would serve one subject's records
 * to another. That is not a hypothetical bug, it is the whole failure mode,
 * which is why this is a controller-scoped interceptor and not a global one.
 */
/** A day. The rows cannot change; only new ones can appear. */
export const CACHE_SECONDS = 86_400;

/** What every registry response says about its own reusability. */
export function cacheable(response: Response): void {
  response.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}, immutable`);
}

@Injectable()
export class RegistryCacheInterceptor implements NestInterceptor {
  private readonly entries = new Map<string, { body: unknown; etag: string; at: number }>();

  constructor(
    @Inject(KERNEL_CONFIG)
    private readonly config: Pick<KernelConfig, 'REGISTRY_CACHE_SECONDS'>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ttl = this.config.REGISTRY_CACHE_SECONDS * 1000;
    if (ttl === 0) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Only GETs, and only the ones with no caller identity attached. A request
    // carrying a subject header is not necessarily registry traffic and must
    // never be answered from a cache keyed on the URL alone.
    if (request.method !== 'GET' || request.headers['x-clycites-subject'] !== undefined) {
      return next.handle();
    }

    const key = request.originalUrl;
    const now = Date.now();
    const hit = this.entries.get(key);

    if (hit !== undefined && now - hit.at < ttl) {
      // The controller does not run on a hit, so everything it would have set
      // has to be set here. Cache-Control especially: a response that quietly
      // stopped saying it was cacheable would make every downstream cache
      // revalidate, which is the opposite of the point.
      cacheable(response);
      response.setHeader('ETag', hit.etag);
      response.setHeader('X-Cache', 'hit');
      if (matches(request.headers['if-none-match'], hit.etag)) {
        response.status(304);
        return of(undefined);
      }
      return of(hit.body);
    }

    return next.handle().pipe(
      tap((body: unknown) => {
        // A thrown NotFoundException never reaches here, so 404s are not
        // cached. They are cheap and they are the one registry answer that can
        // legitimately change without a deploy — a code inserted by a
        // migration turns a 404 into a 200.
        if (body === undefined || body === null) return;
        if (this.entries.size > 512) this.evict(now, ttl);

        const etag = etagOf(body);
        this.entries.set(key, { body, etag, at: now });
        response.setHeader('ETag', etag);
        response.setHeader('X-Cache', 'miss');
      }),
    );
  }

  private evict(now: number, ttl: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= ttl) this.entries.delete(key);
    }
    // Still full, so everything in it is live. Drop the oldest half rather
    // than growing without bound; the registry has far fewer than 512
    // addressable URLs, so reaching this means somebody is fuzzing query
    // strings and the right answer is to stop holding their results.
    if (this.entries.size > 512) {
      const oldest = [...this.entries.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, Math.floor(this.entries.size / 2));
      for (const [key] of oldest) this.entries.delete(key);
    }
  }
}

/** A strong validator over the serialised body. */
function etagOf(body: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('base64url');
  return `"${hash.slice(0, 27)}"`;
}

function matches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (raw.trim() === '*') return true;
  return raw
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//u, ''))
    .includes(etag);
}
