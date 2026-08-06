# 0042 — Public registry data is CC0 and separate from personal-data export

**Status:** accepted

The registry schema contains immutable reference data and no data subject. Its
conversion catalogue, samples, provenance, CSV/JSON distributions, and DCAT
descriptor are public under CC0 1.0.

The personal-data export prohibition remains unchanged. Bulk registry routes
query only `registry.unit_conversion` and its sample rows; they do not share a
repository method with facts, inferences, consent, audit, or media. The route
guard continues to prohibit personal-data export surfaces.

Public availability is best effort, not a contractual service level. Strong
caching and permanent row URLs make citations durable across outages.