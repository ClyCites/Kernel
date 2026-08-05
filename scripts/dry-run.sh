#!/usr/bin/env bash
#
# The full-system dry run. Work order Q2.
#
#   scripts/dry-run.sh [--keep]
#
# One command, against a clean database. Not a test suite — a rehearsal, in the
# order the field would produce, printing what it did so a human can read it.
#
# The shell owns the sequence because three of the eleven stages are operator
# jobs rather than API calls: anchoring is a cron batch, verification is a
# separate process that must not share a heap with the kernel, and backup and
# restore happen with the kernel stopped. Those are exactly the joins no unit
# test exercises, so they are exactly the joins this script exists to hold.
#
# --keep leaves Postgres, MinIO and the kernel running afterwards.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

WORK="$ROOT/tmp/dry-run"
LOG="$WORK/kernel.log"
HANDOFF="$WORK/handoff.json"
BACKUPS="$WORK/backups"
PORT="${DRY_RUN_PORT:-3100}"
BASE="http://127.0.0.1:$PORT"

DB_IMAGE="imresamu/postgis:16-3.5"
OWNER_URL_HOST="postgres://clycites_owner:clycites_owner_dev_only@localhost:5433/clycites"
OWNER_URL_NET="postgres://clycites_owner:clycites_owner_dev_only@127.0.0.1:5432/clycites"
SCRATCH_URL_NET="postgres://clycites_owner:clycites_owner_dev_only@127.0.0.1:5432/clycites_restore_scratch"

rm -rf "$WORK"
mkdir -p "$WORK" "$BACKUPS"

RULE="$(printf '─%.0s' $(seq 1 74))"
KERNEL_PID=""
STARTED_AT="$(date -u +%s)"

banner() {
  printf '\n┌%s\n│ Stage %s — %s\n└%s\n' "$RULE" "$1" "$2" "$RULE"
}

step() { printf '  %s\n' "$*"; }

STAGE_AT=0
mark() { STAGE_AT="$(date -u +%s)"; }
took() { printf '  ── stage %s took %ss\n' "$1" "$(( $(date -u +%s) - STAGE_AT ))"; }

die() {
  printf '\n!! %s\n' "$*" >&2
  printf '!! stopping. A dry run that gets patched into passing tells you less\n' >&2
  printf '!! than one that stops.\n' >&2
  exit 1
}

psql_owner() {
  docker exec clycites-kernel-db psql -qtAX -U clycites_owner -d clycites -c "$1"
}

cleanup() {
  [ -n "$KERNEL_PID" ] && kill "$KERNEL_PID" 2>/dev/null
  if [ "$KEEP" -eq 0 ]; then
    docker compose down -v >/dev/null 2>&1
  fi
}
trap cleanup EXIT

printf '\n%s\n' "$RULE"
printf 'ClyCites kernel — full-system dry run\n'
printf 'started %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$RULE"

# ─────────────────────────────────────────────────────────────────────────────
banner 1 "stand up"
mark

step "tearing down anything left over, volumes included"
docker compose down -v >/dev/null 2>&1

step "starting Postgres and MinIO from empty volumes"
docker compose up -d postgres minio minio-init >/dev/null 2>&1 || die "compose up failed"

health=""
for _ in $(seq 1 60); do
  health="$(docker inspect -f '{{.State.Health.Status}}' clycites-kernel-db 2>/dev/null)"
  [ "$health" = "healthy" ] && break
  sleep 1
done
[ "$health" = "healthy" ] || die "Postgres never became healthy"
step "Postgres healthy"

for _ in $(seq 1 60); do
  health="$(docker inspect -f '{{.State.Health.Status}}' clycites-kernel-objects 2>/dev/null)"
  [ "$health" = "healthy" ] && break
  sleep 1
done
[ "$health" = "healthy" ] || die "MinIO never became healthy"
step "MinIO healthy, bucket provisioned by minio-init"

step ""
step "migrations, from zero"
( cd apps/kernel && ./node_modules/.bin/tsx src/storage/migrate-cli.ts ) 2>&1 |
  sed 's/^/    /' | tail -8
applied="$(psql_owner "select count(*) from kernel.schema_migration")"
step "applied: $applied migrations"

step ""
step "partitions"
psql_owner "
  select n.nspname || '.' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('facts','inference') and c.relispartition and c.relkind = 'r'
  order by 1 desc limit 3" | sed 's/^/    /'
count="$(psql_owner "
  select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('facts','inference') and c.relispartition and c.relkind = 'r'")"
step "    … $count monthly partitions provisioned ahead"
[ "$count" -gt 0 ] || die "no partitions — the first write would have failed"

step ""
step "the app role's grants — this is where append-only actually lives"
for table in facts.record inference.record kernel.record_key; do
  held="$(psql_owner "
    select string_agg(distinct privilege_type, ', ' order by privilege_type)
    from information_schema.role_table_grants
    where grantee = 'kernel_app'
      and table_schema = '${table%%.*}' and table_name = '${table##*.}'")"
  step "    $(printf '%-22s' "$table") $held"
  case "$held" in
    "INSERT, SELECT") ;;
    *) die "kernel_app holds '$held' on $table — invariant 1 is not enforced" ;;
  esac
done
step ""
step "    INSERT and SELECT. Not UPDATE, not DELETE, and no exception for the"
step "    owner's own rows — a correction has to be a new record because the"
step "    database will not accept anything else."
step ""
step "    Every other table where kernel_app holds UPDATE or DELETE, so that the"
step "    exceptions are read rather than assumed:"
psql_owner "
  select table_schema || '.' || table_name || '  ' ||
         string_agg(distinct privilege_type, '+')
  from information_schema.role_table_grants
  where grantee = 'kernel_app' and privilege_type in ('UPDATE','DELETE','TRUNCATE')
  group by table_schema, table_name
  order by 1" | sed 's/^/      /'
step "    Each is transient bookkeeping — an upload offset, a batch status, a"
step "    delivery timestamp. None of them is an observation."

step ""
step "booting the kernel on port $PORT"
(
  cd apps/kernel &&
    PORT="$PORT" SEED_INGEST_ENABLED=false \
      ./node_modules/.bin/tsx src/main.ts >"$LOG" 2>&1
) &
KERNEL_PID=$!

ready=""
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/v1/ready" >/dev/null 2>&1; then ready=yes; break; fi
  sleep 1
done
[ -n "$ready" ] || { sed 's/^/    /' "$LOG" | tail -20; die "the kernel never became ready"; }
step "ready: $(curl -fsS "$BASE/v1/ready")"
took 1

# ─────────────────────────────────────────────────────────────────────────────
# Stages 2 to 6 — enrol, record, confirm, disclose, correct.

( cd apps/kernel && DRY_RUN_BASE_URL="$BASE" ./node_modules/.bin/tsx src/dry-run/run.ts a "$HANDOFF" )
[ $? -eq 0 ] || die "phase A stopped"

DELIVERY="$(node -e "process.stdout.write(require('$HANDOFF').delivery)")"
CORRECTION="$(node -e "const h=require('$HANDOFF');process.stdout.write(h.correction||h.delivery)")"
FARMER="$(node -e "process.stdout.write(require('$HANDOFF').farmer)")"
COOP="$(node -e "process.stdout.write(require('$HANDOFF').coop)")"

# ─────────────────────────────────────────────────────────────────────────────
banner 7 "anchor"
mark

step "running the batch, as cron would"
step "  (with --date today: the job defaults to yesterday because a day is only"
step "   closed once it is over, and every record here was written minutes ago)"
( cd apps/kernel && ./node_modules/.bin/tsx src/anchoring/anchor-cli.ts --date "$(date -u +%F)" ) 2>&1 | sed 's/^/    /'
step ""
step "freshness, as the alert reads it"
( cd apps/kernel && ./node_modules/.bin/tsx src/anchoring/anchor-cli.ts --check ) 2>&1 | sed 's/^/    /'

step ""
step "─── and now, in a separate process that shares nothing with the kernel ───"
step ""
node scripts/verify-external.mjs "$BASE" "$CORRECTION" "$COOP" 2>&1 | sed 's/^/    /'
VERIFY=${PIPESTATUS[0]}
step ""
case "$VERIFY" in
  0) step "external verification: PASSED" ;;
  3) step "external verification: INCOMPLETE — see stage 7 above. Reportable." ;;
  *) die "external verification failed with exit $VERIFY" ;;
esac
took 7

# ─────────────────────────────────────────────────────────────────────────────
# Stages 8 and 9 — subject access, objection.

( cd apps/kernel && DRY_RUN_BASE_URL="$BASE" ./node_modules/.bin/tsx src/dry-run/run.ts b "$HANDOFF" )
[ $? -eq 0 ] || die "phase B stopped"

# ─────────────────────────────────────────────────────────────────────────────
banner 10 "back up and restore"
mark

step "object inventory, before"
( cd apps/kernel && ./node_modules/.bin/tsx src/media/inventory-cli.ts manifest ) 2>&1 |
  tee "$WORK/objects-before.txt" | tail -6 | sed 's/^/    /'

step ""
step "stopping the kernel — a dump taken under load is a dump of a moving target"
kill "$KERNEL_PID" 2>/dev/null
wait "$KERNEL_PID" 2>/dev/null
KERNEL_PID=""

step "dumping as the schema owner, inside the database container's network"
docker run --rm \
  --network "container:clycites-kernel-db" \
  -v "$ROOT:/repo" -w /repo \
  -e BACKUP_PASSPHRASE=dry_run_dev_only \
  "$DB_IMAGE" bash scripts/backup.sh "$OWNER_URL_NET" /repo/tmp/dry-run/backups 2>&1 |
  tail -12 | sed 's/^/    /'

DIR="$(ls -d "$BACKUPS"/*/ 2>/dev/null | tail -1)"
[ -n "$DIR" ] || die "no backup directory was produced"
step ""
step "backup: $(basename "$DIR")"
ls -la "$DIR" | tail -n +2 | awk '{print "    " $9 "  " $5 " bytes"}'

step ""
step "restoring into a scratch database and regenerating the manifest"
docker run --rm \
  --network "container:clycites-kernel-db" \
  -v "$ROOT:/repo" -w /repo \
  -e BACKUP_PASSPHRASE=dry_run_dev_only \
  "$DB_IMAGE" bash scripts/restore.sh "/repo/tmp/dry-run/backups/$(basename "$DIR")" "$SCRATCH_URL_NET" 2>&1 |
  tail -14 | sed 's/^/    /'
RESTORE=${PIPESTATUS[0]}
[ "$RESTORE" -eq 0 ] || die "the restore manifest did not match"
step "restore verified: manifest matched line for line"

step ""
step "Note what the dump said: \"no object store configured — objects NOT"
step "backed up\". That is not a misconfiguration in this rehearsal, it is a"
step "shape problem in the tooling. scripts/backup.sh needs pg_dump, psql and"
step "openssl in one place, and it also needs the Node toolchain to take the"
step "object inventory. The database container has the first three and no"
step "Node; this laptop has Node and none of the first three. There is no"
step "single environment in which the script does the whole of its job."
step ""
step "The inventory either side of the dump — taken separately, above and"
step "below — is what closes the gap here. In production it would not be"
step "closed at all, and the failure mode is a restore that looks perfect"
step "and resolves no photographs."
step ""
step "bringing the kernel back, and proving a MediaRef still resolves"
(
  cd apps/kernel &&
    PORT="$PORT" SEED_INGEST_ENABLED=false \
      ./node_modules/.bin/tsx src/main.ts >>"$LOG" 2>&1
) &
KERNEL_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "$BASE/v1/ready" >/dev/null 2>&1 && break
  sleep 1
done

( cd apps/kernel && ./node_modules/.bin/tsx src/media/inventory-cli.ts verify ) 2>&1 |
  tail -8 | sed 's/^/    /'
INVENTORY=${PIPESTATUS[0]}
[ "$INVENTORY" -eq 0 ] || die "an object the database names is not in the bucket"

HASH="$(node -e "const h=require('$HANDOFF');process.stdout.write(h.contentHash||'')")"
if [ -n "$HASH" ]; then
  url="$(curl -fsS -H "x-clycites-subject: $COOP" "$BASE/v1/media/$HASH/url?purpose=credit_assessment" |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).url))")"
  bytes="$(curl -fsS -o /dev/null -w '%{size_download}' "$url")"
  step "the evidence photograph still resolves after restore: $bytes bytes"
fi
took 10

# ─────────────────────────────────────────────────────────────────────────────
# Stage 11 — the lender view.

( cd apps/kernel && DRY_RUN_BASE_URL="$BASE" ./node_modules/.bin/tsx src/dry-run/run.ts c "$HANDOFF" )

printf '\n%s\n' "$RULE"
printf 'dry run finished in %ss\n' "$(( $(date -u +%s) - STARTED_AT ))"
printf 'kernel log: %s\n' "$LOG"
printf '%s\n' "$RULE"
