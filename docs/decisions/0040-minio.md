# 0040 — MinIO, reversing 0037

**Status**: accepted
**Date**: 2026-08-05
**Supersedes**: the object-store choice in [0037](0037-p5-media.md). The rest of
0037 — the tus flow, metadata stripping, the presigned-URL read path, the
salt-deletion note — is unaffected and still governs.

## The decision

The object store is **MinIO**, pinned to
`ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z`.

This was directed. It is recorded here rather than applied quietly because
0037 considered MinIO and rejected it, and a repository whose compose file
contradicts its own decision log is worse than one that never wrote the
decision down.

## What 0037 said, and whether it is still true

0037 rejected MinIO because its open-source server repository was archived by
its owner in April 2026, the last release was October 2025, and that release
was itself a privilege-escalation fix. The conclusion was that running
photographs of farmers' homesteads on a storage server with no security-patch
path is not defensible.

**All of that is still true.** Nothing has changed about the upstream. The
pinned tag above *is* the October 2025 release. This decision does not rebut
0037's reasoning; it accepts the risk anyway, for reasons of operational
familiarity, and says so plainly so that nobody later reads the swap as
evidence that the concern evaporated.

What follows is therefore not a justification. It is the list of things that
now have to be true for the risk to stay bounded.

## What the swap actually cost

0037 predicted "a change to four environment variables". That held. The
kernel names no implementation; `objects.ts` speaks the S3 subset every store
has. The changes were:

- `docker-compose.yml` — the service, its ports (9000 for S3, 9001 for the
  console, both loopback-bound), and a one-shot `minio-init`.
- `MEDIA_S3_ENDPOINT` from `:3900` to `:9000`, and `MEDIA_S3_REGION`.
- Two `?? 'garage'` fallbacks, now `?? 'us-east-1'`.
- Comments in four files that named the old store.

No migration. No data movement — the dev volume was empty. No change to
`MediaRef`, to `objectKey()`, or to anything a record cites.

## The two properties that stopped being free

This is the part that matters, and the reason this document is longer than the
diff.

**1. The bucket is no longer private by construction.** Garage has no ACLs and
no bucket policies; permissions are granted per access key, so there was no way
to make the bucket public by accident. That was not a setting anyone had to
remember — it was a property of the software. MinIO has both ACLs and anonymous
access policies, so "no public bucket" reverts to being a thing somebody must
not get wrong.

Compose therefore runs `mc anonymous set none` on every start. That is not
belt-and-braces; it is the line that replaces a structural guarantee with an
asserted one. If it is ever removed, the bucket becomes one console click from
public and nothing in the kernel would notice.

**2. The bucket is no longer created by environment variable.** Garage's
`GARAGE_DEFAULT_BUCKET` made the store self-provisioning. MinIO needs `mc mb`,
which is why there is now an init container where there was previously nothing.

Both of these are visible in `docker-compose.yml` and neither is enforced by a
test. That is a gap, and it is named here rather than left to be discovered.

## What has to happen next

- **A patch path, or a documented acceptance with a review date.** The pin is a
  release with a known-fixed CVE behind it and no successor. Someone with the
  authority to accept that risk should record that they have, and when it will
  be looked at again. Until then this document is the only place the exposure
  is written down.
- **An exposure test for the anonymous policy.** `test/ops/exposure.test.ts`
  already asserts every published port is loopback-bound and would catch a
  `0.0.0.0` binding on 9000 or 9001. It does not and cannot assert that the
  bucket policy is `none`, because that is runtime state rather than a file.
  A start-up check in the kernel — refuse to boot if the configured bucket
  answers an unauthenticated GET — would put the property back under the
  kernel's own control rather than compose's.

## What was not done

The console on 9001 is published, to loopback only. It is a convenience for
development and has no business existing in a deployment that holds real
photographs; the runbook should say so before anything real is stored.
