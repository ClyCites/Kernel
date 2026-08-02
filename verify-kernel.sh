#!/usr/bin/env bash
#
# ClyCites kernel foundation — acceptance check (v2)
#
# Run from the repo root:  bash verify-kernel.sh
#
# v2 fixes a design error in v1. The first version grepped the whole tree for
# forbidden patterns, which flagged the invariant TESTS — files whose entire
# purpose is to name a forbidden thing and assert it is rejected. Five of six
# failures in the first run were the checker's fault.
#
# The fix is to invert the logic. For each invariant:
#   (a) the pattern must be ABSENT from application source, and
#   (b) a test asserting it must be PRESENT.
# A missing test is now itself a failure, rather than a silent pass.

set -uo pipefail

PASS=0; FAIL=0; WARN=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; WARN=$((WARN+1)); }
sect() { printf '\n\033[1m%s\033[0m\n' "$1"; }
show() { echo "$1" | head -4 | sed 's/^/        /'; }

EXCL="--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=.turbo --exclude-dir=coverage"

# Application source: excludes tests, migrations, and the read-only schema package.
appsrc() {
  grep -rIn $EXCL "$@" . 2>/dev/null \
    | grep -vE '(^|/)(test|tests|__tests__|migrations)/' \
    | grep -vE '\.(test|spec)\.[tj]s' \
    | grep -v 'packages/schema' || true
}
# Test source only.
tsrc() {
  grep -rIl $EXCL "$@" . 2>/dev/null \
    | grep -E '((^|/)(test|tests|__tests__)/|\.(test|spec)\.[tj]s)' || true
}
sqlsrc() { grep -rIn -i $EXCL --include='*.sql' "$@" . 2>/dev/null || true; }

# An invariant needs both halves: absent from source, asserted in a test.
invariant() {
  local label="$1" pattern="$2" testpat="$3"
  local viol; viol=$(appsrc -iE "$pattern" --include='*.ts' --include='*.sql')
  local proof; proof=$(tsrc -iE "$testpat" --include='*.ts')
  if [ -n "$viol" ]; then
    bad "$label — found in application source"; show "$viol"
  elif [ -z "$proof" ]; then
    bad "$label — absent from source, but NO TEST asserts it"
  else
    ok "$label (asserted in $(echo "$proof" | head -1 | xargs basename))"
  fi
}

sect "1. Schema package integrity"
read -r -d '' SUMS <<'EOF'
ce6059446b809b0b120bad04dfcdaf9cce1eb7da1b6c7400d10991b3966bdf33  package.json
e506105c4e1561406c306ccaa7ab7f85f684aaee195120b9ed554b3197863027  src/entities/index.ts
19dc9f04fa4b74df7959444870826fe84faf4a04541c3a380d6c41363d16ee83  src/enums.ts
81a3ac698403c092bfc63c433e8bb7efe3cac225b2b852b1deb14ad3c0c5023e  src/envelope.ts
c136445ce7f34f2d73e6b5804f2c34e3c67e51a2e7e38b4e43e5dde9e8a8d865  src/index.ts
08fb982e0b685c1df27526d31162d657f200b433d078160867bb10ab1262ac40  src/inference.ts
26cc62ba20a049373a4ff8ba70eb50e6a177583b4860f7e809c6207361e6079d  src/primitives.ts
591bcd19f8a582832b024a214fd31ec153c2c095ed39151c128bfeb2d78342e8  src/values.ts
bf1edeba327ea7b717cf53dd577ee1be3edf596faa53821e7632958b87bc6a6a  test/invariants.test.ts
682f6a2096ec027a77b690ac9fa711111d8a36027482b8a93ef00c310c6a9782  tsconfig.json
EOF
if [ -d packages/schema ]; then
  ( cd packages/schema && echo "$SUMS" | sha256sum -c --quiet - ) 2>/dev/null \
    && ok "byte-identical to 0.2.0" \
    || bad "schema package MODIFIED — diff before accepting anything else"
else
  bad "packages/schema not found"
fi

sect "2. Build and tests"
pnpm install --frozen-lockfile >/dev/null 2>&1 && ok "install (frozen lockfile)" || bad "install failed"
pnpm typecheck >/dev/null 2>&1 && ok "typecheck clean" || bad "typecheck FAILED"
pnpm test >/dev/null 2>&1 && ok "tests pass" || bad "tests FAILED"

sect "3. Append-only (invariant 1)"
invariant "no UPDATE/DELETE on record tables" \
          '\b(update|delete)\s+(from\s+)?(facts|inference)\.' \
          '(update|delete).*(facts|inference)\.record'
[ -n "$(sqlsrc -E 'grant\s+(insert|select)')" ] \
  && ok "role grants present in migrations" \
  || bad "no GRANT statements — append-only not enforced at the database"

sect "4. Inference quarantine (invariant 2)"
[ -n "$(sqlsrc -E 'create schema.*inference')" ] \
  && ok "separate inference schema exists" \
  || bad "no separate inference schema"
# A boolean column, not a constraint name. Constraint names legitimately
# contain 'is_inference'; a column declaration is the failure.
BOOL=$(appsrc -iE '(is_inference|is_predicted|inference_flag)\s+(boolean|bool)' --include='*.sql')
[ -z "$BOOL" ] && ok "separation by namespace, not a boolean column" \
  || { bad "boolean inference flag column found"; show "$BOOL"; }

sect "5. Forbidden concepts (§7)"
invariant "no wallet/balance entity (non-custodial)" \
          '\b(class|interface|type|table)\s+(Wallet|Balance|AccountBalance|FundsHeld)\b' \
          'wallet|custodial'
invariant "no model_estimated measurement method" \
          'model_estimated' \
          'model_estimated|measurement.*method'
# A real default is a .default() call or a SQL DEFAULT clause, not the word
# 'default' inside a test name.
PREC=$(appsrc -E 'occurred_at_precision.*(\.default\(|DEFAULT )' --include='*.ts' --include='*.sql')
[ -z "$PREC" ] && ok "occurred_at_precision has no default" \
  || { bad "occurred_at_precision defaulted"; show "$PREC"; }
OWNED=$(appsrc -w 'owned_by' --include='*.ts' --include='*.sql')
[ -z "$OWNED" ] && ok "held_by used, not owned_by" || { bad "owned_by found"; show "$OWNED"; }

sect "6. Stack discipline (§3)"
node -e '
const fs=require("fs"),path=require("path"),cp=require("child_process");
const files=cp.execSync("ls package.json apps/*/package.json packages/*/package.json 2>/dev/null||true")
  .toString().trim().split("\n").filter(Boolean);
const banned=["prisma","@prisma/client","typeorm","sequelize","mikro-orm","drizzle-orm","redis","ioredis","kafkajs","bullmq"];
const validators=["joi","yup","ajv","class-validator","superstruct"];
let hardFail=false, notes=[];
for(const f of files){
  const p=JSON.parse(fs.readFileSync(f,"utf8"));
  for(const b of banned) if(p.dependencies?.[b]||p.devDependencies?.[b]){
    console.log(`  \x1b[31mFAIL\x1b[0m  forbidden dependency ${b} in ${f}`); hardFail=true; }
  for(const v of validators){
    if(p.dependencies?.[v]){ console.log(`  \x1b[31mFAIL\x1b[0m  ${v} is a runtime dependency in ${f} — second validation layer`); hardFail=true; }
    else if(p.devDependencies?.[v]) notes.push(`${v} (devDependency in ${f})`);
  }
  if(p.dependencies?.zod||p.devDependencies?.zod) notes.push("zod present");
}
if(!hardFail) console.log("  \x1b[32mPASS\x1b[0m  no ORM, cache, queue, or runtime validator");
for(const n of new Set(notes)) if(!n.startsWith("zod")) console.log(`  \x1b[33mWARN\x1b[0m  ${n} — confirm it only validates the generated OpenAPI doc, never requests`);
process.exit(hardFail?1:0);
' || FAIL=$((FAIL+1))

sect "7. Scope and stubs (§6)"
for d in apps/marketplace apps/finance apps/web apps/mobile k8s helm charts; do
  [ -e "$d" ] && bad "out of scope, exists: $d"
done
CONSENT=$(appsrc -iE 'consent' --include='*.ts')
if [ -z "$CONSENT" ]; then
  bad "no consent stub — brief requires an explicit deny-all placeholder"
else
  DENY=$(echo "$CONSENT" | grep -iE 'deny|false|forbid|refuse')
  [ -n "$DENY" ] && ok "consent stub present and appears deny-by-default" \
    || warn "consent code present but deny-by-default not obvious — read it"
fi

sect "8. Documentation and hygiene"
[ -f README.md ] && ok "README.md" || bad "no README.md"
[ -d docs/decisions ] && ok "docs/decisions/ ($(ls docs/decisions 2>/dev/null | wc -l) entries)" || warn "no docs/decisions/"
[ -f docker-compose.yml ] && ok "docker-compose.yml" || bad "no docker-compose.yml"
[ -f .env.example ] && ok ".env.example" || warn "no .env.example"
git ls-files 2>/dev/null | grep -qE '(^|/)\.env$' && bad "SECRET: .env committed" || ok "no committed .env"

printf '\n\033[1m─────────────────────────────────────────\033[0m\n'
printf '  passed %s   failed %s   warnings %s\n\n' "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -eq 0 ]; then
  cat <<'NOTE'
  Mechanical checks clean. Four things still need human eyes:
    1. Connect AS THE APP ROLE and try an UPDATE. It must be Postgres that
       refuses, not a service layer.
    2. Submit the same Delivery three times, count rows. Should be
       ON CONFLICT DO NOTHING, not SELECT-then-INSERT.
    3. Is the OpenAPI document generated from Zod, or transcribed by hand?
    4. Read docs/decisions/ — the surprises live there.
NOTE
else
  echo "  Resolve failures, then review by hand."
fi
exit $(( FAIL > 0 ? 1 : 0 ))