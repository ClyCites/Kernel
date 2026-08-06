#!/usr/bin/env bash

set -uo pipefail

BASE_URL=${1:-}
BASE_URL=${BASE_URL%/}
if [ -z "${1:-}" ] || ! printf '%s' "$BASE_URL" | grep -qE '^https://'; then
  echo "usage: $0 https://kernel.example" >&2
  exit 2
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAILURES=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }
stop() { printf 'STOP  %s\n' "$1" >&2; exit "${2:-1}"; }

for command in curl nc node openssl; do
  command -v "$command" >/dev/null 2>&1 || stop "missing command: $command" 2
done

HOST=$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$BASE_URL")

request() {
  local method=$1 path=$2 prefix=$3
  shift 3
  curl --silent --show-error --max-time 20 \
    --request "$method" --dump-header "$TMP/$prefix.headers" \
    --output "$TMP/$prefix.body" --write-out '%{http_code}' \
    "$@" "$BASE_URL$path"
}

header() {
  local file=$1 name=$2
  awk -v wanted="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" '
    BEGIN { FS=":" }
    tolower($1) == wanted {
      sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0
    }
    END { print value }
  ' "$file"
}

probe() {
  local port=$1
  if nc -h 2>&1 | grep -q -- '-G '; then
    nc -z -G 3 "$HOST" "$port" >/dev/null 2>&1
  else
    nc -z -w 3 "$HOST" "$port" >/dev/null 2>&1
  fi
}

echo 'V1 application role'
if [ -z "${DEPLOY_APP_DATABASE_URL:-}" ] || [ -z "${DEPLOY_MIGRATOR_DATABASE_URL:-}" ]; then
  stop 'set DEPLOY_APP_DATABASE_URL and DEPLOY_MIGRATOR_DATABASE_URL through a secure private route' 2
fi
if (
  cd "$ROOT/apps/kernel" &&
  ./node_modules/.bin/tsx --test --test-reporter=tap \
    test/deployment/deployed-role.test.ts
); then
  pass 'deployed application role is restricted and separate from migrations'
else
  stop 'deployed application-role invariant failed; inspect before continuing' 10
fi

echo 'V2 network exposure'
for port in 5432 5433 3900 3901 9000 9001; do
  if probe "$port"; then
    stop "data service port $port is reachable from outside" 20
  fi
  pass "port $port is closed or filtered"
done

if probe 22; then
  fail 'SSH port 22 is reachable from outside'
else
  pass 'SSH is not reachable from outside'
fi
for port in 80 443; do
  if probe "$port"; then pass "edge port $port is reachable"; else fail "edge port $port is closed"; fi
done

HTTP_HEADERS="$TMP/http.headers"
curl --silent --show-error --max-time 20 --output /dev/null --dump-header "$HTTP_HEADERS" \
  "http://$HOST/"
HTTP_STATUS=$(awk 'toupper($1) ~ /^HTTP\// { status=$2 } END { print status }' "$HTTP_HEADERS")
HTTP_LOCATION=$(header "$HTTP_HEADERS" location)
if { [ "$HTTP_STATUS" = 301 ] || [ "$HTTP_STATUS" = 302 ] || [ "$HTTP_STATUS" = 307 ] || [ "$HTTP_STATUS" = 308 ]; } && \
   printf '%s' "$HTTP_LOCATION" | grep -q '^https://'; then
  pass 'HTTP redirects to HTTPS'
else
  fail "HTTP did not redirect to HTTPS (status ${HTTP_STATUS:-none})"
fi

echo 'V3 public surface and TLS'
HEALTH_STATUS=$(request GET /v1/health health)
if [ "$HEALTH_STATUS" = 200 ]; then pass 'health endpoint is reachable'; else fail "health returned $HEALTH_STATUS"; fi

POWERED_BY=$(header "$TMP/health.headers" x-powered-by)
SERVER=$(header "$TMP/health.headers" server)
[ -z "$POWERED_BY" ] && pass 'X-Powered-By is absent' || fail "X-Powered-By is exposed: $POWERED_BY"
if [ -z "$SERVER" ] || ! printf '%s' "$SERVER" | grep -qE '[/ ][0-9]'; then
  pass 'server version is not exposed'
else
  fail "server version is exposed: $SERVER"
fi

METRICS_STATUS=$(request GET /v1/metrics metrics)
case "$METRICS_STATUS" in
  401|403|404) pass 'metrics are not public' ;;
  *) fail "metrics are public or misconfigured (status $METRICS_STATUS)" ;;
esac

REGISTRY_PATH=${VERIFY_REGISTRY_PATH:-/v1/registry/conversions}
REGISTRY_STATUS=$(request GET "$REGISTRY_PATH" registry)
if [ "$REGISTRY_STATUS" = 200 ]; then pass 'registry reads are public'; else fail "registry read returned $REGISTRY_STATUS"; fi

OPENAPI_PATH=${VERIFY_OPENAPI_PATH:-/openapi.json}
OPENAPI_STATUS=$(request GET "$OPENAPI_PATH" openapi)
if [ "$OPENAPI_STATUS" = 200 ] && node -e '
  const fs=require("fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.exit(typeof value.openapi === "string" ? 0 : 1);
' "$TMP/openapi.body"; then
  pass "OpenAPI is intentionally public at $OPENAPI_PATH"
else
  fail "OpenAPI contract is unavailable at $OPENAPI_PATH (status $OPENAPI_STATUS)"
fi

ERROR_STATUS=$(request GET /v1/records/not-a-uuid malformed)
if grep -qiE '(^|[^a-z])(stack|stacktrace|node_modules|at [A-Za-z0-9_.]+ \()' "$TMP/malformed.body"; then
  fail 'error response contains a stack trace'
else
  pass "error response hides stack traces (status $ERROR_STATUS)"
fi

if curl --silent --show-error --fail --max-time 20 "$BASE_URL/v1/health" >/dev/null && \
   printf '' | openssl s_client -connect "$HOST:443" -servername "$HOST" -brief \
     >"$TMP/tls.out" 2>&1 && \
   grep -qE 'Protocol version: TLSv1\.[23]' "$TMP/tls.out" && \
   ! grep -qiE 'RC4|3DES|NULL' "$TMP/tls.out"; then
  pass 'TLS certificate and negotiated cipher are valid'
else
  fail 'TLS certificate or negotiated cipher check failed'
fi

echo 'V4 refusal policy'
if [ -z "${VERIFY_RECORD_ID:-}" ] || [ -z "${VERIFY_MEDIA_HASH:-}" ]; then
  fail 'set VERIFY_RECORD_ID and VERIFY_MEDIA_HASH to known deployed fixtures'
else
  RECORD_STATUS=$(request GET "/v1/records/$VERIFY_RECORD_ID" refused-record)
  MEDIA_STATUS=$(request GET "/v1/media/$VERIFY_MEDIA_HASH/url" refused-media)
  for kind in record media; do
    if [ "$kind" = record ]; then expected=$VERIFY_RECORD_ID; code=$RECORD_STATUS; else expected=$VERIFY_MEDIA_HASH; code=$MEDIA_STATUS; fi
    if [ "$code" != 404 ]; then
      fail "unauthenticated $kind refusal returned $code, expected 404"
    elif grep -Fq "$expected" "$TMP/refused-$kind.body"; then
      stop "$kind refusal returned its protected identifier" 40
    elif node -e '
      const fs=require("fs");
      const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      delete value.correlation_id;
      const text=JSON.stringify(value);
      process.exit(/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(text) || /[0-9a-f]{64}/i.test(text) ? 1 : 0);
    ' "$TMP/refused-$kind.body"; then
      pass "unauthenticated $kind refusal is an identifier-free 404"
    else
      stop "$kind refusal returned an identifier" 40
    fi
  done
fi

echo 'V5 staging label and live-write guard'
ROOT_STATUS=$(request GET / root)
if [ "$ROOT_STATUS" = 200 ] && node -e '
  const fs=require("fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.exit(value.environment === "staging" ? 0 : 1);
' "$TMP/root.body"; then
  pass 'API root labels the deployment as staging'
else
  fail "API root is not labelled staging (status $ROOT_STATUS)"
fi

LIVE_STATUS=$(request POST /v1/records live-write \
  --header 'content-type: application/json' --data '{}')
if [ "$LIVE_STATUS" -ge 200 ] && [ "$LIVE_STATUS" -lt 300 ]; then
  stop 'a live-dataset write succeeded on staging' 50
elif [ "$LIVE_STATUS" = 503 ] && \
     [ "$(header "$TMP/live-write.headers" x-live-ingest-disabled)" = true ]; then
  pass 'structural guard refused a live-dataset write'
else
  fail "live write was not refused by the staging guard (status $LIVE_STATUS)"
fi

echo 'V6-V8 deployed operational checks'
run_hook() {
  local label=$1 variable=$2
  local executable=${!variable:-}
  if [ -z "$executable" ]; then
    fail "set $variable to an executable external verification hook ($label)"
  elif [ ! -x "$executable" ]; then
    fail "$variable is not executable: $executable"
  elif "$executable" "$BASE_URL"; then
    pass "$label"
  else
    fail "$label"
  fi
}

# These checks need deployment-specific access that the public API deliberately
# does not provide. Hooks keep the top-level verifier portable while ensuring a
# missing host audit, restore, or eleven-stage rehearsal can never look green.
run_hook 'host secrets and rotated Hedera key verified' VERIFY_SECRETS_HOOK
run_hook 'deployed backup restored and verified' VERIFY_RESTORE_HOOK
run_hook 'eleven-stage remote dry run completed with stage timings' VERIFY_DRY_RUN_HOOK

if [ "$FAILURES" -ne 0 ]; then
  printf '\nverify-deployment: %d check(s) failed\n' "$FAILURES" >&2
  exit 1
fi

echo 'verify-deployment: all deployment gates passed'