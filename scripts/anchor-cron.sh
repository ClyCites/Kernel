#!/usr/bin/env bash
#
# The daily anchoring run, and the check that notices when it stops.
#
#   scripts/anchor-cron.sh run     — build yesterday's batch and publish it
#   scripts/anchor-cron.sh check   — assert a fresh root exists; alert if not
#
# Install both. They are separate schedules on purpose.
#
#   # m  h  dom mon dow
#     15 1  *   *   *   cd /srv/clycites/kernel && scripts/anchor-cron.sh run   >> /var/log/clycites/anchor.log 2>&1
#     45 9  *   *   *   cd /srv/clycites/kernel && scripts/anchor-cron.sh check >> /var/log/clycites/anchor.log 2>&1
#
# Why two entries and not one script that does both:
#
# A check that runs as part of the anchoring job cannot report that the
# anchoring job stopped running. If the crontab line is removed, the container
# is not restarted, or the host is rebuilt without this file, there is no
# failed run to find — there is nothing at all, and nothing raises no alert.
# Every monitoring arrangement that watches exit codes has this hole. The way
# out is to alert on the absence of an expected root rather than on the
# presence of an error, which means the check must be able to fire on a day
# the batch never ran.
#
# `check` runs eight hours after `run` so a single late or retried batch does
# not page anybody; ANCHOR_STALE_AFTER_DAYS in anchor.service.ts sets the real
# tolerance at three days.
#
# The better arrangement, if you have Prometheus, is the alert rule at the
# bottom of this file: it reads the same measure off /v1/metrics and does not
# depend on this script being installed either. Use both. This one is for
# deployments with a crontab and a mail spool and nothing else.

set -euo pipefail

# Must run from apps/kernel, not the repo root. tsx reads the nearest
# tsconfig.json for `experimentalDecorators`, and the root does not set it, so
# invoking the CLI from anywhere else fails at transform time on the first
# `@Inject` it meets — which looks exactly like a broken kernel rather than a
# wrong working directory.
cd "$(dirname "$0")/../apps/kernel"

MODE="${1:-run}"
TSX="./node_modules/.bin/tsx"
CLI="src/anchoring/anchor-cli.ts"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ ! -x "$TSX" ]; then
  echo "anchor-cron: $TSX not found — run pnpm install first" >&2
  exit 78
fi

case "$MODE" in
  run)
    echo "anchor-cron: $STAMP run"
    # Exit 75 (EX_TEMPFAIL) means the batch was built and stored but the
    # message did not reach the topic. The records are in a tree with a root;
    # the next run sends it. That is not an incident, so it is not reported as
    # one — but it is not swallowed either, because a 75 every day for a week
    # is a credential problem that `check` will eventually catch and this line
    # explains sooner.
    set +e
    "$TSX" "$CLI"
    code=$?
    set -e

    case "$code" in
      0) ;;
      75) echo "anchor-cron: batch stored, publication deferred — will retry" >&2 ;;
      *)
        echo "anchor-cron: run failed with exit $code" >&2
        exit "$code"
        ;;
    esac
    ;;

  check)
    echo "anchor-cron: $STAMP check"
    # Non-zero here means no fresh root exists, whatever the reason — the
    # scheduler was never installed, the topic credentials expired, the
    # container has been down since Friday. All of those look identical from
    # the outside, and all of them mean the same thing: nothing recorded since
    # the last root can be shown to predate today.
    if ! "$TSX" "$CLI" --check; then
      echo "anchor-cron: ALERT — anchoring is not current. See docs/runbook.md §7." >&2
      exit 1
    fi
    ;;

  *)
    echo "anchor-cron: unknown mode '$MODE' — expected run or check" >&2
    exit 64
    ;;
esac

# Prometheus, for deployments that scrape /v1/metrics:
#
#   - alert: AnchoringStopped
#     expr: kernel_anchor_stale == 1
#     for: 1h
#     annotations:
#       summary: No Merkle root published in {{ $value }} days
#       runbook: docs/runbook.md#7-anchoring
#
#   - alert: AnchoringCoversNothing
#     expr: kernel_anchor_unanchored_age_days > 3
#     for: 1h
#     annotations:
#       summary: >-
#         Roots are being published but records from
#         {{ $value }} days ago are still uncovered.
#
# The second is the one people forget. A batch can run, publish, and cover
# almost nothing — a partition that stopped being scanned, a dataset filter
# that got inverted — and freshness alone stays green throughout.
