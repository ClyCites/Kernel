# Deploying on Coolify

This deployment runs the kernel, PostGIS, migrations and private S3-compatible
object storage. The Android field client is built separately; Coolify hosts the
API it synchronizes with.

## Security boundary

Do not assign a public Coolify domain directly to the `kernel` service. The
kernel trusts `x-clycites-subject`, `x-clycites-client-id` and `x-acting-for`
because an authentication gateway is required to remove caller-supplied values
and replace them from a validated Authentik token. Publishing the service
directly makes those identities forgeable.

The repository does not yet contain that gateway. The Compose deployment is
therefore private by default. A production launch needs a gateway which:

1. Terminates TLS and validates the Authentik access token.
2. Removes all three identity headers from the inbound request.
3. Sets the verified subject and OAuth client identifier from token claims.
4. Permits `x-acting-for` only after checking the represented party.
5. Proxies to `http://kernel:3000` on the private Compose network.

## Create the resource

1. In Coolify, create a **Docker Compose** resource from this repository.
2. Set the compose file to `/docker-compose.coolify.yaml` and the base directory
   to `/`.
3. Add the environment variables below. Use URL-safe random values containing
   only letters and digits for database passwords because they are interpolated
   into PostgreSQL URLs.
4. Deploy. Do not add a domain to `postgres`, `minio`, `minio-init`, `migrate`
   or `kernel`.

Required secrets:

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | PostgreSQL schema-owner password |
| `KERNEL_APP_PASSWORD` | Restricted application-role password |
| `KERNEL_TRAINING_PASSWORD` | Read-only training-role password |
| `MINIO_ROOT_USER` | Private object-store access key |
| `MINIO_ROOT_PASSWORD` | Private object-store secret key |

Generate suitable values locally with `openssl rand -hex 32`. Keep all five
different. Coolify should mark them as runtime secrets and never expose them in
build logs.

Optional settings include `AUDIT_SHIP_URL`, `AUDIT_SHIP_TOKEN` and the
`ANCHOR_*` variables. Leave anchoring on `testnet` until the documented mainnet
acknowledgement has been reviewed. Production always runs with seed ingest off
and the special-data consent check on.

## First deployment

The `migrate` service waits for PostgreSQL, applies every forward-only migration
and provisions the restricted roles. The kernel starts only after migrations
and private bucket initialization succeed. On later deployments the migration
job verifies checksums and applies only new files.

From another service on the same private network, readiness is available at:

```text
http://kernel:3000/v1/ready
```

After the Authentik gateway is deployed, assign the public API domain to the
gateway and verify that forged identity headers are removed before setting the
field build variables:

```dotenv
EXPO_PUBLIC_API_URL=https://api.example.org/v1
EXPO_PUBLIC_OIDC_ISSUER=https://auth.example.org/application/o/field/
EXPO_PUBLIC_OIDC_CLIENT_ID=field-client
EXPO_PUBLIC_ACTING_FOR=<cooperative-party-uuid>
```

SQLCipher requires an Android development or release build; the client cannot
run in Expo Go.

## Persistence and backups

`kernel-pgdata` and `kernel-objects-data` are named persistent volumes. Enable
Coolify backups for both, but retain the repository backup scripts and perform
restore drills: a volume snapshot alone does not prove that PostgreSQL and the
object inventory agree.