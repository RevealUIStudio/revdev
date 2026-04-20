#!/usr/bin/env bash
# Generate NOTICE.md from all third-party dependencies.
# Requires: npx (Node), cargo-about (Rust), go-licenses (Go)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
OUT="$ROOT/NOTICE.md"

echo "Generating NOTICE.md..."

cat > "$OUT" <<'HEADER'
# Third-Party Notices

This file lists third-party dependencies and their licenses.
Auto-generated — do not edit manually. Regenerate with:

```bash
bash scripts/generate-notice.sh
```

HEADER

# ---------------------------------------------------------------------------
# Node.js dependencies (production only)
# ---------------------------------------------------------------------------
echo "## Node.js Dependencies" >> "$OUT"
echo "" >> "$OUT"
echo "| Package | License |" >> "$OUT"
echo "|---------|---------|" >> "$OUT"

cd "$ROOT"
if command -v npx &>/dev/null; then
  npx --yes license-checker-rspack --production --csv 2>/dev/null \
    | tail -n +2 \
    | awk -F',' '{gsub(/"/, "", $1); gsub(/"/, "", $2); if ($1 != "" && $2 != "") printf "| %s | %s |\n", $1, $2}' \
    >> "$OUT" || echo "| (license-checker-rspack not available) | — |" >> "$OUT"
else
  echo "| (npx not available) | — |" >> "$OUT"
fi

echo "" >> "$OUT"

# ---------------------------------------------------------------------------
# Rust dependencies
# ---------------------------------------------------------------------------
echo "## Rust Dependencies" >> "$OUT"
echo "" >> "$OUT"
echo "| Crate | License |" >> "$OUT"
echo "|-------|---------|" >> "$OUT"

cd "$ROOT/apps/studio/src-tauri"
if command -v cargo-about &>/dev/null; then
  cargo about generate --format json 2>/dev/null \
    | jq -r '.licenses[] | .used_by[] | "| \(.crate.name) \(.crate.version) | \(.crate.license) |"' \
    >> "$OUT" 2>/dev/null || echo "| (cargo-about not available or failed) | — |" >> "$OUT"
elif [ -f Cargo.lock ]; then
  # Fallback: parse Cargo.lock for crate names (no license info)
  grep '^name = ' Cargo.lock \
    | sed 's/name = "//;s/"//' \
    | sort -u \
    | awk '{printf "| %s | (see crate metadata) |\n", $0}' \
    >> "$OUT"
fi

echo "" >> "$OUT"

# ---------------------------------------------------------------------------
# Go dependencies
# ---------------------------------------------------------------------------
echo "## Go Dependencies" >> "$OUT"
echo "" >> "$OUT"
echo "| Module | License |" >> "$OUT"
echo "|--------|---------|" >> "$OUT"

cd "$ROOT/apps/console"
if command -v go &>/dev/null; then
  go list -m all 2>/dev/null \
    | tail -n +2 \
    | awk '{printf "| %s %s | (see go.sum) |\n", $1, $2}' \
    >> "$OUT" || echo "| (go not available) | — |" >> "$OUT"
else
  echo "| (go not available) | — |" >> "$OUT"
fi

echo "" >> "$OUT"
echo "---" >> "$OUT"
echo "" >> "$OUT"
echo "Generated on $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT"

echo "Done: $OUT"
