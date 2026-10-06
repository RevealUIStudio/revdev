#!/usr/bin/env bash
# check-client-leaks.sh
#
# Scans the repo for any reference to a specific RevealUI Studio client,
# prospect, or warm-intro contact. Customer/prospect names belong in the
# private internal repo only. Never in this public surface.
#
# Exit 0 on clean. Exit 1 on any violation. Exit 2 on tool/setup error.
#
# Usage:
#   bash scripts/check-client-leaks.sh                     # scan repo root
#   bash scripts/check-client-leaks.sh <path> [<path>...]  # scan specific paths
#   LEAK_JSON=1 bash scripts/check-client-leaks.sh         # machine-readable
#
# CI wiring: .github/workflows/check-client-leaks.yml
# REQUIRED status check on `test` and `main` branch protection.
#
# Pattern source (never a committed file):
#   CLIENT_LEAK_PATTERNS, one pattern per line:
#     tag|literal-string|reason
#   Blank lines and lines whose first non-space character is # are ignored.
#   In CI the workflow passes the org Actions secret of that name.
#   Locally, if the env var is unset or empty, the gitignored file
#   .client-name-watchlist.local is the fallback.
#   Add a new client / prospect / contact by adding a line to the
#   CLIENT_LEAK_PATTERNS org secret. Never add the line to a committed file.
#   There is no .leakignore for this scanner. The property must be unconditional.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN_PATHS=("$@")
[[ ${#SCAN_PATHS[@]} -eq 0 ]] && SCAN_PATHS=("$REPO_ROOT")

for _path in "${SCAN_PATHS[@]}"; do
  if [[ ! -e "$_path" ]]; then
    echo "[client-leak] error: scan path not found: $_path" >&2
    exit 2
  fi
done
unset _path

# --- Patterns: tag | literal-string | reason ---
#
# REGEX-CONFIG-BOUNDARY: the strings consumed by grep -F (fixed strings),
# so each pattern is a literal substring. No metacharacter handling.
# No regex authored.
#
# Loaded at runtime. Coverage for a new client / prospect must be added to
# the CLIENT_LEAK_PATTERNS org secret, not to this file.

PATTERNS=()

parse_pattern_text() {
  local text="$1"
  local origin="$2"
  local line trimmed tag rest pattern
  local n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    trimmed="${line#"${line%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    tag="${trimmed%%|*}"
    rest="${trimmed#*|}"
    if [[ "$rest" == "$trimmed" || "$rest" != *"|"* || -z "$tag" ]]; then
      echo "[client-leak] error: ${origin} line ${n} is not tag|literal|reason" >&2
      exit 2
    fi
    pattern="${rest%%|*}"
    if [[ -z "$pattern" ]]; then
      echo "[client-leak] error: ${origin} line ${n} has an empty literal" >&2
      exit 2
    fi
    PATTERNS+=("$trimmed")
  done <<< "$text"
}

in_ci=0
if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
  in_ci=1
fi

if [[ -n "${CLIENT_LEAK_PATTERNS+x}" && -n "${CLIENT_LEAK_PATTERNS}" ]]; then
  parse_pattern_text "$CLIENT_LEAK_PATTERNS" "CLIENT_LEAK_PATTERNS"
fi

if [[ ${#PATTERNS[@]} -eq 0 ]]; then
  if [[ "$in_ci" -eq 1 ]]; then
    echo "[client-leak] error: CLIENT_LEAK_PATTERNS is empty or unset." >&2
    echo "[client-leak] CI must receive the org Actions secret CLIENT_LEAK_PATTERNS." >&2
    echo "[client-leak] Refusing to report a clean scan with no pattern list loaded." >&2
    exit 2
  fi
  local_list="$REPO_ROOT/.client-name-watchlist.local"
  if [[ -f "$local_list" ]]; then
    parse_pattern_text "$(<"$local_list")" ".client-name-watchlist.local"
  fi
fi

if [[ ${#PATTERNS[@]} -eq 0 ]]; then
  echo "[client-leak] warning: no pattern list loaded." >&2
  echo "[client-leak] Set CLIENT_LEAK_PATTERNS, or add lines to the gitignored file .client-name-watchlist.local." >&2
  echo "[client-leak] This is not a clean scan." >&2
  exit 2
fi

# Directories / file globs to skip.
# The local watchlist holds the literals, so it must not be scanned.
# The scanner script and the gitleaks issue config no longer carry those
# literals, so both are scanned.
EXCLUDE_DIRS=(node_modules .git dist build .next .turbo .pnpm coverage target .direnv .nyc_output playwright-report test-results)
EXCLUDE_FILES=(
  pnpm-lock.yaml package-lock.json yarn.lock Cargo.lock
  .client-name-watchlist.local
  CHANGELOG.md
  '*.png' '*.jpg' '*.jpeg' '*.gif' '*.webp' '*.pdf' '*.zip' '*.tar.gz' '*.tgz'
  '*.ico' '*.woff' '*.woff2' '*.ttf' '*.otf'
  '*.har' '*.snap'
)

if ! command -v grep >/dev/null 2>&1; then
  echo "[client-leak] error: grep not found on PATH" >&2
  exit 2
fi

grep_excludes=()
for d in "${EXCLUDE_DIRS[@]}"; do
  grep_excludes+=(--exclude-dir="$d")
done
for f in "${EXCLUDE_FILES[@]}"; do
  grep_excludes+=(--exclude="$f")
done

violations=0
json_entries=()

for entry in "${PATTERNS[@]}"; do
  tag="${entry%%|*}"
  rest="${entry#*|}"
  pattern="${rest%%|*}"
  reason="${rest#*|}"

  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    file="${hit%%:*}"
    rest_="${hit#*:}"
    line="${rest_%%:*}"
    content="${rest_#*:}"

    if [[ -n "${LEAK_JSON:-}" ]]; then
      if command -v jq >/dev/null 2>&1; then
        json_entries+=("$(jq -cn --arg tag "$tag" --arg file "$file" --arg line "$line" --arg reason "$reason" --arg content "$content" \
          '{tag:$tag, file:$file, line:($line|tonumber), reason:$reason, content:$content}')")
      else
        safe="${content//\\/\\\\}"
        safe="${safe//\"/\\\"}"
        safe="${safe//$'\n'/\\n}"
        safe="${safe//$'\t'/\\t}"
        sreason="${reason//\\/\\\\}"
        sreason="${sreason//\"/\\\"}"
        json_entries+=("{\"tag\":\"$tag\",\"file\":\"$file\",\"line\":$line,\"reason\":\"$sreason\",\"content\":\"$safe\"}")
      fi
    else
      printf '[CLIENT-LEAK:%s] %s:%s: %s\n  → %s\n' "$tag" "$file" "$line" "$reason" "$content"
    fi
    violations=$((violations+1))
  done < <(grep -rFIn "${grep_excludes[@]}" -- "$pattern" "${SCAN_PATHS[@]}" 2>/dev/null || true)
done

if [[ -n "${LEAK_JSON:-}" ]]; then
  printf '{"violations":%d,"entries":[%s]}\n' "$violations" "$(IFS=,; echo "${json_entries[*]:-}")"
fi

if (( violations > 0 )); then
  if [[ -z "${LEAK_JSON:-}" ]]; then
    echo "" >&2
    echo "[client-leak] FAIL: $violations violation(s)." >&2
    echo "" >&2
    echo "Customer / prospect names must NEVER appear in this public-facing repo." >&2
    echo "Move the content to the private internal repo (or genericize with a" >&2
    echo "placeholder like 'Acme Corp' / 'acme' / 'first customer')." >&2
    echo "" >&2
    echo "If a new client onboards and their name needs scanner coverage, add" >&2
    echo "the pattern line to the CLIENT_LEAK_PATTERNS org secret. Never add" >&2
    echo "it to a committed file." >&2
  fi
  exit 1
fi

[[ -z "${LEAK_JSON:-}" ]] && echo "[client-leak] OK: no client/prospect names detected across: ${SCAN_PATHS[*]}"
exit 0
