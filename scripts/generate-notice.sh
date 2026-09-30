#!/usr/bin/env bash
# Verified, failure-atomic attribution; tools must already be installed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/generate-notice.mjs" "$@"
