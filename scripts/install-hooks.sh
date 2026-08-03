#!/usr/bin/env bash
#
# Install the repository's git hooks. Run once after cloning:
#
#   bash scripts/install-hooks.sh
#
# Uses core.hooksPath so the hooks are version controlled rather than living
# only in whoever's .git directory happened to run this.

set -euo pipefail

cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
echo "hooks: core.hooksPath = .githooks"
