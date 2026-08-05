import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { KERNEL_CONFIG, type KernelConfig } from '../config.js';
import { CLIENT_HEADER } from './subject.js';

type RateConfig = Pick<
  KernelConfig,
  'REGISTRY_RATE_LIMIT' | 'REGISTRY_RATE_WINDOW_SECONDS'
>;

function clientIdOf(request: Request): string | null {
  const value = request.headers?.[CLIENT_HEADER];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A fixed-window limiter for the one surface that has no authenticated caller.
 *
 * Every other route is governed by `x-clycites-subject`, so abuse has a name
 * attached to it. The registry is deliberately open — see
 * docs/decisions/0024 — which means the only thing between it and a scraper is
 * this.
 *
 * FINDING, stated rather than hidden: the window is in process memory. It is
 * per replica, it resets on deploy, and behind N instances the effective limit
 * is N times the configured one. That is adequate for a single-instance kernel
 * behind a gateway and is not a substitute for a limit at the edge. When the
 * gateway grows one, this should become the second line rather than the first.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly hits = new Map<string, { count: number; resets: number }>();

  constructor(
    @Inject(KERNEL_CONFIG)
    private readonly config: RateConfig,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const limit = this.config.REGISTRY_RATE_LIMIT;
    const windowMs = this.config.REGISTRY_RATE_WINDOW_SECONDS * 1000;
    const now = Date.now();
    const clientId = clientIdOf(request);
    const key = clientId === null
      ? `ip:${request.ip ?? 'unknown'}`
      : `client:${clientId}`;

    if (this.hits.size > 10_000) this.evict(now);

    const entry = this.hits.get(key);
    const window =
      entry === undefined || entry.resets <= now
        ? { count: 0, resets: now + windowMs }
        : entry;

    window.count += 1;
    this.hits.set(key, window);

    const remaining = Math.max(0, limit - window.count);
    const resetsIn = Math.ceil((window.resets - now) / 1000);

    response.setHeader('RateLimit-Limit', String(limit));
    response.setHeader('RateLimit-Remaining', String(remaining));
    response.setHeader('RateLimit-Reset', String(resetsIn));

    if (window.count > limit) {
      response.setHeader('Retry-After', String(resetsIn));
      response.status(429).type('application/problem+json').json({
        type: '/problems/429',
        title: 'Too many requests',
        status: 429,
        detail: `This caller has exceeded ${limit} requests per ${this.config.REGISTRY_RATE_WINDOW_SECONDS}s.`,
        instance: request.originalUrl,
      });
      return;
    }

    next();
  }

  private evict(now: number): void {
    for (const [key, window] of this.hits) {
      if (window.resets <= now) this.hits.delete(key);
    }
  }
}

/** Authenticated non-registry traffic is limited by verified OAuth client. */
@Injectable()
export class ClientRateLimitMiddleware implements NestMiddleware {
  private readonly hits = new Map<string, { count: number; resets: number }>();

  constructor(@Inject(KERNEL_CONFIG) private readonly config: RateConfig) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const clientId = clientIdOf(request);
    if (clientId === null) {
      next();
      return;
    }

    const limit = this.config.REGISTRY_RATE_LIMIT;
    const windowMs = this.config.REGISTRY_RATE_WINDOW_SECONDS * 1000;
    const now = Date.now();
    const entry = this.hits.get(clientId);
    const window =
      entry === undefined || entry.resets <= now
        ? { count: 0, resets: now + windowMs }
        : entry;

    window.count += 1;
    this.hits.set(clientId, window);

    const remaining = Math.max(0, limit - window.count);
    const resetsIn = Math.ceil((window.resets - now) / 1000);
    response.setHeader('RateLimit-Limit', String(limit));
    response.setHeader('RateLimit-Remaining', String(remaining));
    response.setHeader('RateLimit-Reset', String(resetsIn));

    if (window.count > limit) {
      response.setHeader('Retry-After', String(resetsIn));
      response.status(429).type('application/problem+json').json({
        type: '/problems/429',
        title: 'Too many requests',
        status: 429,
        detail: `This client has exceeded ${limit} requests per ${this.config.REGISTRY_RATE_WINDOW_SECONDS}s.`,
        instance: request.originalUrl,
      });
      return;
    }

    next();
  }
}
