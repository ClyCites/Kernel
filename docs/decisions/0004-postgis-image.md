# 0004 — PostGIS image for local development

**Status:** accepted
**Date:** 2026-08-02

## Context

§3 fixes the database as PostgreSQL 16 + PostGIS. The canonical image,
`postgis/postgis:16-3.5`, publishes `amd64` only:

```
no matching manifest for linux/arm64/v8 in the manifest list entries
```

Development happens on Apple Silicon. Running the amd64 image under emulation
works but is slow enough to make integration tests unpleasant, and Testcontainers
will pull the same image in every test run.

## Decision

Use `imresamu/postgis:16-3.5`, the multi-arch build of the same Dockerfile
maintained by a PostGIS Docker maintainer. It publishes `amd64` and `arm64`, so
one tag serves both local development and CI.

Verified: PostgreSQL 16.10, PostGIS 3.5.

## Consequences

- The image is not under the `postgis` organisation. If that matters for supply
  chain policy, the alternative is `ghcr.io/baosystems/postgis:16` (also
  multi-arch) or building from the official Dockerfile.
- The tag is pinned to a minor version, not `latest`.
