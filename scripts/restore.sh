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
for f in kernel.dump.enc manifest.txt; do
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
 where n.nspname in ('facts', 'inference', 'registry', 'kernel')
 order by 1;

select 'privilege ' || g.table_schema || '.' || g.table_name || ' '
       || g.grantee || ' ' || g.privilege_type
  from information_schema.role_table_grants g
 where g.table_schema in ('facts', 'inference', 'registry', 'kernel')
 order by 1;
SQL
)

echo "restore: regenerating the manifest"
printf '%s\n' "$MANIFEST_SQL" | psql --quiet "$TARGET" > "$WORK/manifest.txt"

if diff -u "$DIR/manifest.txt" "$WORK/manifest.txt" > "$WORK/manifest.diff"; then
  echo "restore: verified — $(wc -l < "$DIR/manifest.txt" | tr -d ' ') manifest lines match"
  exit 0
fi

echo "restore: FAILED — the restored database is not the one that was dumped" >&2
echo "         - is the dump, + is what came back" >&2
sed 's/^/         /' "$WORK/manifest.diff" >&2
exit 1
