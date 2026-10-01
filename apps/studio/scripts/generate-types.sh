#!/bin/bash
# Generate TypeScript type bindings from Rust structs via ts-rs.
#
# Usage:
#   bash apps/studio/scripts/generate-types.sh
#
# This runs `cargo test` in src-tauri/ which triggers ts-rs to write
# .ts files into src-tauri/bindings/, then copies them to src/generated/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STUDIO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_DIR="$STUDIO_DIR/src-tauri"
GENERATED_DIR="$STUDIO_DIR/src/generated"

RELAY_BIN="$TAURI_DIR/wsl/revdev-relay"
# Existence, not -x: the Linux ELF from Studio Release is not executable
# on Windows, and cargo-building the relay there fails (UnixStream).
if [ ! -f "$RELAY_BIN" ]; then
  if [ "$(uname -s)" != "Linux" ]; then
    echo "error: $RELAY_BIN is missing and this host cannot build the Linux ELF."
    echo "       On Linux: cargo build --release --manifest-path apps/studio/relay/Cargo.toml"
    echo "       On Windows release: the linux-relay job must download it first."
    exit 1
  fi
  echo "==> Building gitignored wsl/revdev-relay for tauri-build..."
  cargo build --release --manifest-path "$STUDIO_DIR/relay/Cargo.toml"
  mkdir -p "$(dirname "$RELAY_BIN")"
  cp "$STUDIO_DIR/relay/target/release/revdev-relay" "$RELAY_BIN"
  chmod +x "$RELAY_BIN"
fi

echo "==> Running cargo test to generate ts-rs bindings..."
cd "$TAURI_DIR"
STAGING_DIR="$(mktemp -d "$STUDIO_DIR/.generate-types.XXXXXX")"
EXPORT_DIR="$STAGING_DIR/exports"
OUTPUT_DIR="$STAGING_DIR/output"
BACKUP_DIR="$STAGING_DIR/previous"
mkdir -p "$EXPORT_DIR" "$OUTPUT_DIR"

restore_previous_output() {
  local status=$?
  local preserve_staging=0
  if [ -d "$BACKUP_DIR" ] && [ ! -e "$GENERATED_DIR" ]; then
    if ! mv "$BACKUP_DIR" "$GENERATED_DIR"; then
      status=1
      preserve_staging=1
      echo "error: could not restore previous generated bindings; backup retained at $BACKUP_DIR" >&2
    fi
  fi
  if [ "$preserve_staging" -eq 0 ]; then
    rm -rf "$STAGING_DIR"
  fi
  exit "$status"
}
trap restore_previous_output EXIT

# A new export root prevents deleted Rust types from surviving in ignored
# bindings directories. Explicit `export_to = "bindings/"` types remain under
# the nested bindings directory and are included below.
TS_RS_EXPORT_DIR="$EXPORT_DIR" cargo test --lib

echo "==> Staging generated bindings..."

# Collect default exports and explicit `export_to = "bindings/"` exports.
shopt -s nullglob
files=("$EXPORT_DIR"/*.ts "$EXPORT_DIR/bindings"/*.ts)
if [ ${#files[@]} -eq 0 ]; then
  echo "error: ts-rs generated no TypeScript bindings." >&2
  exit 1
fi

for file in "${files[@]}"; do
  name="$(basename "$file")"
  if [ -e "$OUTPUT_DIR/$name" ]; then
    echo "error: duplicate generated TypeScript binding: $name" >&2
    exit 1
  fi
  cp "$file" "$OUTPUT_DIR/$name"
done

echo "==> Replacing $GENERATED_DIR with ${#files[@]} fresh type files..."
if [ -e "$GENERATED_DIR" ]; then
  mv "$GENERATED_DIR" "$BACKUP_DIR"
fi
if ! mv "$OUTPUT_DIR" "$GENERATED_DIR"; then
  if [ -d "$BACKUP_DIR" ]; then mv "$BACKUP_DIR" "$GENERATED_DIR"; fi
  echo "error: could not publish generated TypeScript bindings." >&2
  exit 1
fi

echo "==> Done."
