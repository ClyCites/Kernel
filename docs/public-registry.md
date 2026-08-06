# Public registry

The registry is public because it contains reference data, not personal data:
unit conversions and samples, crop codes, administrative regions, observation
types, grading schemes, and anchor verification material. It requires no
subject, purpose, grant, or lawful basis.

## Citation and licence

Conversion responses carry a permanent URL and a citation containing the
schema version and registry as-at date. `dataset.json` is a DCAT descriptor.
Complete JSON and CSV distributions are available at:

- `/v1/registry/conversions.json`
- `/v1/registry/conversions.csv`

Registry data is dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The software and
schema package use Apache-2.0; these are deliberately separate licences.

Most conversion factors are assumptions rather than field measurements. Every
row exposes `basis`, and collection responses publish counts for `measured`,
`assumed_default`, and `published_standard`. Sample provenance should determine
whether a factor is suitable for a particular use.

## Operations

Rows are append-only and responses use strong ETags with a one-day immutable
cache policy. A generous per-address limit exists to stop abuse, not meter use.

The service has no contractual availability objective. The operational target
is best-effort public availability with planned changes announced in repository
release notes. Consumers must cache cited rows and must not treat the live API
as their only copy of a factor.

The bulk distributions do not weaken the personal-data export boundary. They
query only the `registry` schema, which cannot contain farmer records.