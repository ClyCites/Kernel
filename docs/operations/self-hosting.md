# Self-hosting

A self-hosted organisation is the data controller for its own instance. It is
responsible for lawful basis, notices, retention, subject rights, security,
backups, and any cross-border processing. Running this software does not make
ClyCites the controller or processor for that deployment.

## Baseline

Use `docker-compose.coolify.yaml` as the production reference. Keep PostgreSQL,
MinIO, migrations, and the kernel on a private network. Publish only an HTTPS
gateway that validates Authentik tokens, strips caller-supplied identity
headers, and writes trusted claims before proxying to the kernel.

Use distinct random credentials for the schema owner, `kernel_app`, training
role, and object store. The request-serving container receives only the
restricted application database credential. Run migrations as a one-shot job
before starting a new kernel image. Never edit an applied migration.

Required operations:

- Back up PostgreSQL and object storage together and perform restore drills.
- Protect `/v1/metrics` with `METRICS_BASIC_AUTH` or leave it hidden.
- Ship audit entries off-box.
- Keep database and object-store ports off public interfaces.
- Run `scripts/verify-deployment.sh` after every deployment.
- Keep live ingest disabled until the deployment's legal and security gates
  are complete.

For Coolify-specific steps and variables, see [Deploying on
Coolify](coolify.md). The local Compose file is a development dependency stack,
not a production deployment.