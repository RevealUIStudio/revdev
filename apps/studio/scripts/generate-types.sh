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
cargo test --lib

echo "==> Copying bindings to $GENERATED_DIR..."
mkdir -p "$GENERATED_DIR"

# Collect .ts files from both bindings/ and bindings/bindings/ —
# ts-rs v10 writes to the latter because `export_to = "bindings/"` is
# relative to the crate root rather than the test harness dir.
shopt -s nullglob
files=("$TAURI_DIR/bindings"/*.ts "$TAURI_DIR/bindings/bindings"/*.ts)
if [ ${#files[@]} -gt 0 ]; then
    cp "${files[@]}" "$GENERATED_DIR/"
    echo "==> Copied ${#files[@]} type files."
else
    echo "==> Warning: No .ts files found under $TAURI_DIR/bindings/"
    echo "    This is expected if cargo test hasn't been run yet."
    echo "    The bindings will be generated when cargo test runs in a"
    echo "    full Tauri build environment."
fi

echo "==> Done."
