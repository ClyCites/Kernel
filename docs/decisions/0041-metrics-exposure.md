# 0041 — Metrics require HTTP authentication

**Status:** accepted

## Decision

`/v1/metrics` is operational infrastructure, not a public API. The kernel
requires HTTP Basic authentication before it computes or returns metrics. If no
credential is configured, the route is hidden with a 404 response.

The credential is supplied through `METRICS_BASIC_AUTH` in `username:password`
form by the deployment's secret store. It is not committed or stored beside a
backup. Prometheus uses the same standard Basic-auth support to scrape it.

## Why

The endpoint contains no personal data, but it does disclose operational
intelligence: lawful-basis distribution, objection effects, delegation grounds,
seed volume, anchoring freshness and the share of mass based on assumptions.
Public access provides no independent-verification benefit. The registry and
published roots remain public because their value depends on independent access.

Network-only restriction would be preferable once the monitoring system and
kernel share a private network, but Coolify's generated exposure must not be
assumed from a repository Compose file. Authentication is enforceable by the
application in every topology and fails closed when configuration is absent.

## Consequences

- External unauthenticated requests receive 404 or 401, never metrics.
- Scrapers need a credential from the deployment secret store.
- Credential rotation does not require a build.
- The endpoint should still be removed from public routing when private
  monitoring networking is available; authentication remains defence in depth.