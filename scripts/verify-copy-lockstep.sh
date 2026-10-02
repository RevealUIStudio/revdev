#!/usr/bin/env bash
# verify-copy-lockstep.sh — shared CI/local gate for revcon copy-mode materialization
#
# GAP-372 design (shared gate, not per-repo ports of revealui rules-lockstep.ts):
#   One script, many consumers. Each fleet repo that materializes
#   .revealui/content/{rules,commands,agents,skills} via `link.sh --mode copy`
#   runs this gate in
#   CI so hand-edits and stray tracked files fail the build.
#
# Self-consistency only (no sibling revcon profile checkout required):
#   1. .revealui/.revcon-manifest.json present, mode=copy
#   2. Every manifest entry exists as a real file (not a symlink) with matching sha256
#   3. Every git-tracked native content file appears in the manifest
#
# Profile-source freshness (stale vs current profiles) remains an operator
# concern via status.sh (needs the revcon checkout). CI only needs the
# tracked tree to match its own manifest.
#
# Usage:
#   bash scripts/verify-copy-lockstep.sh --target /path/to/repo
#   bash scripts/verify-copy-lockstep.sh --target . --dot .claude  # optional adapter
#
# Exit: 0 ok · 1 drift / missing manifest · 2 usage error

set -euo pipefail

TARGET=""
DOT=".revealui"

usage() {
  cat <<'EOF'
Usage: verify-copy-lockstep.sh --target DIR [--dot .revealui|.claude]

Options:
  --target DIR   Repo root that owns the materialized editor dir (required)
  --dot NAME     Materialized root (default: .revealui)
  -h, --help     Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --dot)    DOT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "error: --target is required" >&2
  usage >&2
  exit 2
fi

case "$DOT" in
  .revealui) MATERIALIZED_SUBDIRS=(content/rules content/commands content/agents content/skills) ;;
  .claude) MATERIALIZED_SUBDIRS=(rules agents skills) ;;
  *) echo "error: unsupported materialized root: $DOT" >&2; exit 2 ;;
esac

if [[ ! -d "$TARGET" ]]; then
  echo "error: target is not a directory: $TARGET" >&2
  exit 2
fi

TARGET="$(cd "$TARGET" && pwd)"
MANIFEST="$TARGET/$DOT/.revcon-manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "✗ missing $DOT/.revcon-manifest.json" >&2
  echo "  Materialize with revcon:" >&2
  echo "    bash ~/revealfleet/revcon/link.sh --target $TARGET --profile revealfleet --editor ${DOT#.} --mode copy" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 2
fi

# Parse and validate the entire manifest before checking any paths. A parser
# failure inside process substitution would otherwise leave the outer loop's
# exit status at zero and allow a malformed manifest to pass as an empty one.
if ! manifest_rows="$(jq -s -r --arg dot "$DOT" '
  if length == 1 and (.[0] | type == "object") then
    .[0] as $m |
    if ($m.mode == "copy")
      and ($m.editor == $dot[1:])
      and ($m.profiles | type == "array")
      and all($m.profiles[]; type == "string")
      and ($m.files | type == "object")
      and (if $dot == ".revealui" then ($m.files | length > 0) else true end)
      and all($m.files | to_entries[];
        ((if $dot == ".revealui" then
            (.key | startswith("content/rules/") or startswith("content/commands/")
              or startswith("content/agents/") or startswith("content/skills/"))
          else
            (.key | startswith("rules/") or startswith("agents/") or startswith("skills/"))
          end)
          and (.key | split("/") | all(.[]; length > 0 and . != "." and . != ".."))
          and (.key | test("[[:cntrl:]]") | not)
          and (.value | type == "object")
          and (.value.source | type == "string")
          and (.value.source | length > 0)
          and (if $dot == ".revealui" then (.value.source | contains("/revealui/")) else true end)
          and (.value.source | test("[[:cntrl:]]") | not)
          and (.value.sha256 | type == "string")
          and (.value.sha256 | test("^[0-9a-f]{64}$"))))
    then $m.files | to_entries[] | tojson | @base64
    else error("invalid copy manifest schema") end
  else error("expected exactly one manifest object") end
' "$MANIFEST" 2>/dev/null)"; then
  echo "✗ $DOT/.revcon-manifest.json is not one valid copy manifest" >&2
  exit 1
fi

hash_file() {
  sha256sum < "$1" | awk '{print $1}'
}

problems=0
count=0
declare -A manifest_paths=()

while IFS= read -r encoded; do
  [[ -n "$encoded" ]] || continue
  row="$(printf '%s' "$encoded" | base64 -d)"
  rel="$(jq -r '.key' <<< "$row")"
  src="$(jq -r '.value.source' <<< "$row")"
  want="$(jq -r '.value.sha256' <<< "$row")"
  count=$((count + 1))
  file_rel="$DOT/$rel"
  manifest_paths["$file_rel"]=1
  abs="$TARGET/$DOT/$rel"
  if [[ ! -e "$abs" ]]; then
    echo "  $file_rel — missing on disk (manifest source: $src)" >&2
    problems=$((problems + 1))
    continue
  fi
  if [[ -L "$abs" ]]; then
    echo "  $file_rel — still a symlink; re-materialize with link.sh --mode copy" >&2
    problems=$((problems + 1))
    continue
  fi
  if [[ ! -f "$abs" ]]; then
    echo "  $file_rel — not a regular file" >&2
    problems=$((problems + 1))
    continue
  fi
  have="$(hash_file "$abs")"
  if [[ "$have" != "$want" ]]; then
    echo "  $file_rel — content differs from the manifest (locally edited?)." >&2
    echo "    Edit the revcon profile ($src), then re-run link.sh --mode copy." >&2
    problems=$((problems + 1))
  fi
done <<< "$manifest_rows"

# Strays: git-tracked under materialized dirs but not in the manifest.
# A failed inventory cannot prove lockstep, so reject it instead of treating
# an empty error output as a clean tracked tree.
if ! git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: target is not a git work tree; cannot check tracked strays" >&2
  exit 2
fi
pathspecs=()
for sub in "${MATERIALIZED_SUBDIRS[@]}"; do
  pathspecs+=("$DOT/$sub")
done
if [[ "$DOT" == ".revealui" ]]; then
  pathspecs+=(".claude")
fi
tracked_file_list="$(mktemp)"
trap 'rm -f -- "$tracked_file_list"' EXIT
if ! git -C "$TARGET" ls-files -z -- "${pathspecs[@]}" > "$tracked_file_list"; then
  echo "error: git could not list tracked editor files" >&2
  exit 2
fi
while IFS= read -r -d '' tracked; do
  if [[ "$DOT" == ".revealui" && "$tracked" == .claude/* ]]; then
    echo "  $tracked — tracked vendor content; materialize first-party content in .revealui." >&2
    problems=$((problems + 1))
    continue
  fi
  if [[ -z "${manifest_paths[$tracked]+x}" ]]; then
    echo "  $tracked — tracked but not in the manifest (hand-added?)." >&2
    echo "    Add it to the revcon profile and re-run link.sh --mode copy, or untrack it." >&2
    problems=$((problems + 1))
  fi
done < "$tracked_file_list"

profiles="$(jq -r '.profiles | join(", ")' "$MANIFEST" 2>/dev/null || echo "?")"

if (( problems > 0 )); then
  echo "✗ copy-lockstep: $problems violation(s) ($count manifest entr(y/ies), profiles: $profiles)" >&2
  echo "  Re-apply: bash ~/revealfleet/revcon/link.sh --target $TARGET --editor ${DOT#.} --mode copy --profile …" >&2
  exit 1
fi

echo "✓ copy-lockstep: $count materialized file(s) match the manifest (profiles: $profiles); no strays"
exit 0
