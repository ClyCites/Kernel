# API reference

Generated from `apps/kernel/openapi.json`, which is itself generated from the
Zod schemas. Nothing on this page is written by hand, and CI fails if the
committed contract differs from what the schemas produce.

!!! warning "Two rules the contract cannot express"

    `openapi.json` is JSON Schema, and JSON Schema has no way to say *this field
    requires that one*. The kernel enforces these; a client generated from the
    document alone will not know about them until it receives a 422.

    - `on_behalf_of` requires `delegation`
    - `normalized_kg` requires `conversion_id`

## Surfaces

| | |
|---|---|
| `POST /v1/records` | Append one record |
| `GET /v1/records` | Current records, filtered and paged |
| `GET /v1/records/{id}` | Any record, including superseded and retracted |
| `GET /v1/records/{id}/chain` | Every version, oldest first |
| `POST /v1/deliveries/{id}/confirmation` | The counterparty confirms |
| `GET /v1/inferences/{id}` | The inference namespace, by name only |
| `POST /v1/devices` | Register a device |
| `POST /v1/sync/outbox` | Drain a batch captured offline |
| `GET /v1/sync/changes` | Everything appended since a cursor |
| `GET /v1/registry/**` | Public reference data, no subject, no consent gate |
| `GET /v1/anchors/roots` | Published roots — no subject required, and currently empty |
| `GET /v1/health`, `/v1/ready` | Liveness, readiness |
| `GET /v1/metrics` | Prometheus text; hidden unless HTTP authentication is configured |
| `POST /v1/clients/sandbox/registrations` | Record an Authentik-backed sandbox registration |

Errors are RFC 9457 problem documents and carry a correlation id. Refusals to
disclose are bare 404s carrying no identifiers — see
[Read path](../flows/read-path.md).

---

!!swagger openapi.json!!
