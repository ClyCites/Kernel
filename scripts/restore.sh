#!/usr/bin/env bash
#
# Restore a backup into a scratch database and prove it came back whole.
# Exit 0 only when the regenerated manifest matches the one taken at dump time,
# line for line. See docs/decisions/0020.
#
#   BACKUP_PASSPHRASE=... scripts/restore.sh <backup-dir> <target-url>
#
# The target is dropped and recreated, so its name must say it is disposable.

set -euo pipefail

DIR="${1:-}"
TARGET="${2:-${RESTORE_DATABASE_URL:-}}"

if [ -z "$DIR" ] || [ -z "$TARGET" ]; then
  echo "usage: BACKUP_PASSPHRASE=... $0 <backup-dir> <target-url>" >&2
  exit 2
fi
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "restore: BACKUP_PASSPHRASE is not set" >&2
  exit 2
fi
for f in kernel.dump.enc manifest.txt objects.txt; do
  [ -f "$DIR/$f" ] || { echo "restore: $DIR/$f is missing" >&2; exit 2; }
done

for tool in pg_restore psql openssl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "restore: $tool is not on PATH" >&2
    exit 2
  }
done

# The target database name, taken off the end of the url and stripped of any
# query string.
DBNAME="${TARGET##*/}"
DBNAME="${DBNAME%%\?*}"
ADMIN="${TARGET%/*}/postgres"

case "$DBNAME" in
  *restore*|*test*|*scratch*) ;;
  *)
    echo "restore: refusing to drop \"$DBNAME\" — the target name must contain" >&2
    echo "         restore, test or scratch. This script destroys its target." >&2
    exit 2
    ;;
esac

if [ -f "$DIR/checksums.sha256" ]; then
  echo "restore: checking the archive against its checksums"
  ( cd "$DIR" && sha256sum --check --status checksums.sha256 ) || {
    echo "restore: the backup does not match its own checksums" >&2
    exit 1
  }
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "restore: decrypting"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_PASSPHRASE -in "$DIR/kernel.dump.enc" -out "$WORK/kernel.dump"

echo "restore: recreating $DBNAME"
psql --quiet --set ON_ERROR_STOP=on "$ADMIN" \
  -c "drop database if exists \"$DBNAME\" with (force)" \
  -c "create database \"$DBNAME\""

echo "restore: restoring"
# --exit-on-error, because a restore that reports success after skipping a
# failed CREATE CONSTRAINT is the exact failure this whole script exists to
# catch. --single-transaction so a partial restore leaves nothing behind.
pg_restore --dbname="$TARGET" --exit-on-error --single-transaction \
  "$WORK/kernel.dump"

# ─────────────────────────────────────────────────────────────────────────────
# The manifest query.
#
# Duplicated verbatim from scripts/backup.sh, deliberately. A shared helper
# would let the two drift while still agreeing with each other, which would
# make this comparison pass while meaning nothing. See the long note in
# backup.sh for what each section is for and why fingerprints are over keys
# rather than whole rows.
# ─────────────────────────────────────────────────────────────────────────────
MANIFEST_SQL=$(cat <<'SQL'
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset footer off

create function pg_temp.fingerprint(sch text, tbl text)
  returns table (n bigint, digest text)
  language plpgsql as $fn$
declare
  keycols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by k.ord)
    into keycols
    from pg_constraint c
    join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.contype = 'p'
     and c.conrelid = format('%I.%I', sch, tbl)::regclass;

  if keycols is null then
    raise exception 'table %.% has no primary key to fingerprint', sch, tbl;
  end if;

  return query execute format(
    'select count(*)::bigint,
            coalesce(md5(string_agg(k, %L order by k)), %L)
       from (select concat_ws(%L, %s) as k from %I.%I) s',
    '|', 'empty', ':', keycols, sch, tbl);
end
$fn$;

-- Note the absence of `audit` here, which is deliberate and is not an
-- oversight. Restoring a database is itself a long sequence of DDL, and the
-- audit log records DDL — so audit.entry has more rows after a restore than it
-- had at backup, by construction. Fingerprinting it would make this check fail
-- every time it was run correctly. The audit schema is verified below instead,
-- on the two properties that actually carry the guarantee: its constraints and
-- its grants.
select 'table ' || t.sch || '.' || t.tbl || ' ' || f.n || ' ' || f.digest
  from (
    select n.nspname as sch, c.relname as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('facts', 'inference', 'registry', 'kernel')
       and c.relkind in ('r', 'p')
       and not c.relispartition
  ) t
  cross join lateral pg_temp.fingerprint(t.sch, t.tbl) f
 order by 1;

select 'constraint ' || n.nspname || ' ' || c.conname
       || ' valid=' || c.convalidated
  from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
 where n.nspname in ('facts', 'inference', 'registry', 'kernel', 'audit')
 order by 1;

-- Grants are where append-only actually lives (0006, 0017), so a restore that
-- quietly widened one is the failure this whole section exists to catch. The
-- audit schema is included because `kernel_app` holding SELECT on audit.entry
-- would be a serious regression and would show up nowhere else.
select 'privilege ' || g.table_schema || '.' || g.table_name || ' '
       || g.grantee || ' ' || g.privilege_type
  from information_schema.role_table_grants g
 where g.table_schema in ('facts', 'inference', 'registry', 'kernel', 'audit')
 order by 1;

-- The object inventory (work order H). Postgres is no longer the only data
-- store: media bytes live in a bucket, and a restore that recovers the
-- database but not the bucket leaves every MediaRef pointing at nothing while
-- every count, key and constraint still matches. This line is what makes that
-- failure visible. The bucket side is checked separately, by
-- src/media/inventory-cli.ts, because it is not something SQL can see.
select 'object ' || i.dataset || ' ' || i.object_count || ' '
       || i.byte_total || ' ' || i.digest
  from kernel.object_inventory i
 order by 1;

-- Published roots (work order P6). Everything above this line is a claim we
-- make about our own backup, checked against a manifest we also wrote. That is
-- worth something against corruption and nothing against ourselves. These
-- lines are different in kind: each root was published to a public consensus
-- topic on the day it covers, and the topic and sequence number are where
-- anyone can go and read the same value back without asking us.
--
-- A restore that reproduces these roots from its own restored leaves has been
-- verified against evidence it could not have manufactured. That check is
-- src/anchoring/anchor-cli.ts --verify, which restore.sh runs; this section is
-- how the coordinates travel with the backup.
select 'anchor ' || r.batch_date || ' ' || r.merkle_root || ' '
       || r.record_count || ' ' || r.network || ' '
       || coalesce(r.topic_id, '-') || '/' || coalesce(r.sequence_number::text, '-')
  from kernel.published_root r
 order by 1;
SQL
)

echo "restore: regenerating the manifest"
printf '%s\n' "$MANIFEST_SQL" | psql --quiet "$TARGET" > "$WORK/manifest.txt"

# The object section is not SQL and cannot be regenerated from the database, so
# it is lifted out before the diff and checked on its own. Its absence is a
# refusal: a manifest with no object line was written by something that did not
# take an inventory, and a restore verified against it would prove only that
# Postgres came back.
OBJECT_LINE="$(grep '^object_inventory ' "$DIR/manifest.txt" || true)"
if [ -z "$OBJECT_LINE" ]; then
  echo "restore: FAILED — this backup's manifest has no object section, so it" >&2
  echo "         cannot say whether the objects were ever backed up. Refusing" >&2
  echo "         to report a verified restore on half the data." >&2
  exit 1
fi
grep -v '^object_inventory ' "$DIR/manifest.txt" > "$WORK/manifest.expected"

if diff -u "$WORK/manifest.expected" "$WORK/manifest.txt" > "$WORK/manifest.diff"; then
  echo "restore: verified — $(wc -l < "$WORK/manifest.expected" | tr -d ' ') manifest lines match"

  # The bucket. The manifest above proves the database came back; this proves
  # the objects it names came back too. A restore that passed the first and
  # failed the second is the specific silent failure work order H asked for:
  # every MediaRef resolving to a key that is not there.
  OBJECT_STATE="$(printf '%s' "$OBJECT_LINE" | awk '{print $2}')"
  echo "restore: backup recorded objects as $OBJECT_STATE"

  if [ "$OBJECT_STATE" = "declared-absent" ]; then
    if [ -n "${MEDIA_S3_ENDPOINT:-}" ]; then
      echo "restore: FAILED — the backup declared no object store, but one is" >&2
      echo "         configured here. The objects in it are not from this backup." >&2
      exit 1
    fi
  elif [ -n "${MEDIA_S3_ENDPOINT:-}" ]; then
    echo "restore: verifying the object inventory"
    ( cd "$(dirname "$0")/../apps/kernel" \
      && BACKUP_DATABASE_URL="$TARGET" \
         ./node_modules/.bin/tsx src/media/inventory-cli.ts verify ) || {
      echo "restore: FAILED — the database came back but the objects did not" >&2
      exit 1
    }
  elif [ "${RESTORE_OBJECTS_DEFERRED:-}" = "true" ]; then
    # The same split the backup needs: object verification wants the Node
    # toolchain, and this script wants pg_restore and psql. Where those live in
    # different places the object half has to run elsewhere — but it must never
    # be possible for that to look like success. Exit 3 is the honest answer:
    # the database is verified, the objects are not, and nobody may call this
    # restore checked until the deferred step has run and passed.
    echo "restore: database verified; OBJECTS NOT VERIFIED (deferred)"
    echo "         run: apps/kernel tsx src/media/inventory-cli.ts verify"
    echo "         against this database, with MEDIA_S3_ENDPOINT set."
    DEFERRED_OBJECTS=1
  else
    echo "restore: FAILED — the backup holds an object inventory but no store" >&2
    echo "         is configured to check it against. Set MEDIA_S3_ENDPOINT," >&2
    echo "         or RESTORE_OBJECTS_DEFERRED=true to run that step elsewhere." >&2
    exit 1
  fi

  # Published roots (work order P6). Everything above this point compares the
  # restore against a manifest we wrote at backup time. That catches corruption
  # and would not catch us. Each published root was on a public consensus topic
  # before this restore existed, so a restore that reproduces it from its own
  # restored leaves has been checked against evidence nobody here could have
  # made up. That is a materially stronger statement, and it is the reason to
  # run this last rather than treat the manifest as the end of the matter.
  if grep -q '^anchor ' "$DIR/manifest.txt" 2>/dev/null; then
    echo "restore: verifying against published roots"
    ( cd "$(dirname "$0")/../apps/kernel" \
      && DATABASE_URL="$TARGET" \
         ./node_modules/.bin/tsx src/anchoring/anchor-cli.ts --verify ) || {
      echo "restore: FAILED — a restored batch does not reproduce the root that" >&2
      echo "         was published for it. Records are missing or altered." >&2
      exit 1
    }
  fi

  # 3, not 0. The database is verified and the objects are not, and that is
  # neither success nor failure — the same distinction the anchoring CLI draws
  # for a root computed but unpublished.
  [ "${DEFERRED_OBJECTS:-0}" -eq 1 ] && exit 3

  exit 0
fi

echo "restore: FAILED — the restored database is not the one that was dumped" >&2
echo "         - is the dump, + is what came back" >&2
sed 's/^/         /' "$WORK/manifest.diff" >&2
exit 1
