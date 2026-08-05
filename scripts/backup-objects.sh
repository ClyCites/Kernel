#!/usr/bin/env bash
#
# The object half of a backup, split out so it can run somewhere the Node
# toolchain exists.
#
#   scripts/backup-objects.sh <output-file>
#
# FINDING, fixed here: backup.sh needs pg_dump, psql and openssl; the object
# inventory needs tsx and the S3 client. In practice no single image has all
# four, so the inventory was quietly skipped and the backup exited 0 — which
# produces a restore that verifies every manifest line perfectly and resolves
# no photographs. The two halves are now separate steps that a runbook can
# schedule in the two places their tools live, and backup.sh refuses to finish
# without evidence that this one ran.
#
# Set BACKUP_NO_OBJECT_STORE=true to record, deliberately and in writing, that
# this deployment holds no objects.

set -euo pipefail

OUT="${1:-}"
if [ -z "$OUT" ]; then
  echo "backup-objects: usage: backup-objects.sh <output-file>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$(dirname "$OUT")"

if [ "${BACKUP_NO_OBJECT_STORE:-}" = "true" ]; then
  if [ -n "${MEDIA_S3_ENDPOINT:-}" ]; then
    echo "backup-objects: BACKUP_NO_OBJECT_STORE=true but MEDIA_S3_ENDPOINT is set." >&2
    echo "                One of the two is wrong and guessing which would lose data." >&2
    exit 1
  fi
  # Not an empty file. An empty file is what a crashed inventory also leaves.
  echo "no-object-store" > "$OUT"
  echo "backup-objects: none configured, and declared so"
  exit 0
fi

if [ -z "${MEDIA_S3_ENDPOINT:-}" ]; then
  echo "backup-objects: no object store is configured." >&2
  echo "                If that is correct, say so: BACKUP_NO_OBJECT_STORE=true." >&2
  echo "                If it is not, this backup would have silently omitted" >&2
  echo "                every photograph the records cite." >&2
  exit 1
fi

if [ ! -x "$ROOT/apps/kernel/node_modules/.bin/tsx" ]; then
  echo "backup-objects: tsx is not installed here. Run this step where the" >&2
  echo "                kernel's toolchain lives and pass the result to" >&2
  echo "                backup.sh as BACKUP_OBJECTS_FILE." >&2
  exit 2
fi

echo "backup-objects: taking the inventory"
if ! ( cd "$ROOT/apps/kernel" \
       && ./node_modules/.bin/tsx src/media/inventory-cli.ts manifest ) > "$OUT"; then
  rm -f "$OUT"
  echo "backup-objects: FAILED — the store is configured but could not be read." >&2
  exit 1
fi

if [ ! -s "$OUT" ]; then
  rm -f "$OUT"
  echo "backup-objects: FAILED — the inventory came back empty." >&2
  exit 1
fi

echo "backup-objects: $(wc -l < "$OUT" | tr -d ' ') lines"
