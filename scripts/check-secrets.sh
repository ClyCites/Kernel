#!/usr/bin/env bash
#
# Refuse to commit a credential. See docs/decisions/0020.
#
#   scripts/check-secrets.sh              # everything tracked by git
#   scripts/check-secrets.sh --staged     # what is about to be committed
#
# Deliberately narrow. A scanner that fires on every base64 string gets turned
# off within a week, and a disabled scanner is worse than none because it stays
# in CI implying coverage. This one matches credential formats that are
# unambiguous, and secret-shaped assignments whose value does not look like a
# placeholder.

set -uo pipefail

if [ "${1:-}" = "--staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM)
else
  FILES=$(git ls-files)
fi

# Binaries, lockfiles and the generated contract. None can hold a hand-written
# credential, and all are large enough to slow the scan to the point of being
# skipped.
FILES=$(printf '%s\n' "$FILES" | grep -vE \
  '(^|/)(pnpm-lock\.yaml|openapi\.json)$|\.(png|jpe?g|gif|pdf|woff2?|ico)$' || true)
[ -z "$FILES" ] && exit 0

# Values that are obviously not real. Kept generous on purpose: .env.example and
# the docs are only useful if they can show the shape of a setting, and a
# scanner that makes them useless is a scanner somebody turns off.
PLACEHOLDER='dev_only|_test|test_only|changeme|placeholder|example|xxxx|<[^>]*>|\$\{|your[-_]|redacted|\.\.\.'

FOUND=0
report() {
  FOUND=1
  printf '\033[31msecret\033[0m  %s\n' "$1"
}

# ── Unambiguous credential formats ───────────────────────────────────────────
# Each of these is a real provider's key shape. A match is a leak, not a guess.
while IFS= read -r hit; do
  [ -n "$hit" ] && report "$hit"
done < <(
  printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -HnIE \
    -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e 'gh[pousr]_[A-Za-z0-9]{36,}' \
    -e 'sk-[A-Za-z0-9]{32,}' \
    -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
    -e 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.' \
    2>/dev/null || true
)

# ── Secret-shaped assignments with real-looking values ───────────────────────
# A quoted or bare value of at least twelve characters, assigned to something
# named like a credential, that is not one of the placeholder shapes above.
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  value=${hit#*=}
  printf '%s' "$value" | grep -qE "$PLACEHOLDER" && continue
  report "$hit"
done < <(
  printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -HnIE \
    '(PASSWORD|PASSWD|SECRET|API_?KEY|ACCESS_?TOKEN|PRIVATE_?KEY|PASSPHRASE)[A-Z_]*[[:space:]]*[:=][[:space:]]*["'\'']?[^"'\''[:space:],;)}]{12,}' \
    2>/dev/null || true
)

# ── Connection strings carrying an inline password ───────────────────────────
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  printf '%s' "$hit" | grep -qE "$PLACEHOLDER" && continue
  report "$hit"
done < <(
  printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -HnIE \
    '(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp)://[^:/[:space:]]+:[^@[:space:]]{8,}@' \
    2>/dev/null || true
)

if [ "$FOUND" -ne 0 ]; then
  echo
  echo "Refusing to proceed. If one of these is a placeholder, make it look like" >&2
  echo "one — the convention in this repository is a _dev_only or _test suffix." >&2
  exit 1
fi

echo "check-secrets: clean"
