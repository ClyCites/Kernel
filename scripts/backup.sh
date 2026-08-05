#!/usr/bin/env bash
#
# Encrypted dump of the kernel database, plus the manifest that makes a later
# restore verifiable rather than merely attempted. See docs/decisions/0020.
#
#   BACKUP_PASSPHRASE=... scripts/backup.sh [connection-url] [output-dir]
#
# Defaults come from the environment: BACKUP_DATABASE_URL, then
# MIGRATOR_DATABASE_URL. The dump must be taken as the schema owner — a
# kernel_app dump would silently omit the grants that enforce append-only.

set -euo pipefail

URL="${1:-${BACKUP_DATABASE_URL:-${MIGRATOR_DATABASE_URL:-}}}"
OUT_ROOT="${2:-${BACKUP_DIR:-backups}}"

if [ -z "$URL" ]; then
  echo "backup: no connection url — pass one, or set BACKUP_DATABASE_URL" >&2
  exit 2
fi
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "backup: BACKUP_PASSPHRASE is not set; refusing to write a plaintext dump" >&2
  exit 2
fi

for tool in pg_dump psql openssl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "backup: $tool is not on PATH" >&2
    exit 2
  }
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_ROOT/$STAMP"
mkdir -p "$OUT"

# ─────────────────────────────────────────────────────────────────────────────
# The manifest query.
#
# This block is duplicated verbatim in scripts/restore.sh. That is deliberate
# and is the whole point: a shared helper would let the two drift while still
# agreeing with each other, which would make the verification pass while
# meaning nothing. Duplication fails loudly instead. If you change one, change
# the other, and the restore test will tell you if you did not.
#
# Three sections, in ascending order of importance:
#
#   table       row count and a fingerprint over primary keys. Fingerprints are
#               over keys, never whole rows — jsonb key ordering is not stable
#               across server versions, so row-level hashing would produce a
#               false mismatch on every upgrade and the check would be switched
#               off within a month.
#   constraint  every constraint name in the four schemas, with its validated
#               flag. A dropped CHECK is worse than a failed restore: the
#               database still starts, still serves traffic, and the invariant
#               is simply gone. 0019's lawful_basis requirement and 0012's
#               measured-sample requirement are both NOT VALID, so the flag is
#               compared too — a restore that quietly validated them would be a
#               different database.
#   privilege   the table grants. Append-only is enforced by kernel_app not
#               holding UPDATE or DELETE, which is a grant, not a constraint.
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

echo "backup: writing manifest"
printf '%s\n' "$MANIFEST_SQL" | psql --quiet "$URL" > "$OUT/manifest.txt"

if [ ! -s "$OUT/manifest.txt" ]; then
  echo "backup: the manifest is empty — the database is not the kernel's" >&2
  exit 1
fi

echo "backup: dumping"
# --format=custom so pg_restore can be used, and ACLs are kept on purpose:
# the grants are half of what makes the restore correct.
pg_dump --format=custom --compress=9 --dbname="$URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -pass env:BACKUP_PASSPHRASE -out "$OUT/kernel.dump.enc"

# The manifest is not encrypted. It holds counts and catalogue names, no record
# contents, and leaving it readable means a restore can be verified by someone
# who does not hold the passphrase. It is checksummed so tampering shows.
( cd "$OUT" && sha256sum kernel.dump.enc manifest.txt > checksums.sha256 )

echo "backup: $(wc -l < "$OUT/manifest.txt" | tr -d ' ') manifest lines"

# ─────────────────────────────────────────────────────────────────────────────
# The bucket.
#
# The object store is a second data store, and the manifest above only
# fingerprints Postgres. This records what the store actually held at dump
# time, so a later restore has something to be checked against rather than
# being taken on trust.
#
# FINDING, fixed here: this used to print "objects NOT backed up" and exit 0.
# That is the worst available failure mode — in production it produces a
# restore that verifies every manifest line perfectly and resolves no
# photographs. There is now no path through this script that skips objects and
# succeeds. Either an inventory exists, or the absence of a store was declared
# in writing, or the backup fails.
#
# The inventory itself is scripts/backup-objects.sh, because it needs the Node
# toolchain and this script needs pg_dump, psql and openssl. Run it wherever
# those live and pass the result in as BACKUP_OBJECTS_FILE; if the toolchain
# happens to be here too, this runs it directly.
# ─────────────────────────────────────────────────────────────────────────────
if [ -n "${BACKUP_OBJECTS_FILE:-}" ]; then
  if [ ! -s "$BACKUP_OBJECTS_FILE" ]; then
    echo "backup: BACKUP_OBJECTS_FILE=$BACKUP_OBJECTS_FILE is missing or empty" >&2
    exit 1
  fi
  cp "$BACKUP_OBJECTS_FILE" "$OUT/objects.txt"
  echo "backup: object inventory taken from $BACKUP_OBJECTS_FILE"
else
  "$(dirname "$0")/backup-objects.sh" "$OUT/objects.txt"
fi

if [ "$(head -n 1 "$OUT/objects.txt")" = "no-object-store" ]; then
  OBJECT_STATE="declared-absent"
  OBJECT_COUNT=0
else
  OBJECT_STATE="present"
  OBJECT_COUNT="$(wc -l < "$OUT/objects.txt" | tr -d ' ')"
fi

# The manifest records that this step ran. restore.sh refuses to verify against
# a manifest with no object line, so an old-format backup — or one taken by a
# script that skipped this — cannot be quietly accepted as complete.
{
  echo "object_inventory $OBJECT_STATE $OBJECT_COUNT"
} >> "$OUT/manifest.txt"

# Rewritten rather than appended to: manifest.txt changed above, so its earlier
# checksum is of a file that no longer exists.
( cd "$OUT" && sha256sum kernel.dump.enc manifest.txt objects.txt > checksums.sha256 )

echo "backup: objects $OBJECT_STATE ($OBJECT_COUNT)"
echo "backup: output=$OUT"
