#!/usr/bin/env bash
# Install RevDev Harness Daemon as a system service.
# Detects platform (systemd or launchd) and installs the appropriate unit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve daemon binary location
DAEMON_BIN=""
if command -v revdev-daemon &>/dev/null; then
  DAEMON_BIN="$(command -v revdev-daemon)"
elif [ -f "$HOME/.local/bin/revdev-daemon" ]; then
  DAEMON_BIN="$HOME/.local/bin/revdev-daemon"
else
  echo "Error: revdev-daemon not found on PATH or in ~/.local/bin/"
  echo "Install it first: pnpm --filter @revdev/daemon build && ln -s \$(pwd)/packages/daemon/dist/cli.js ~/.local/bin/revdev-daemon"
  exit 1
fi

echo "Using daemon binary: $DAEMON_BIN"

# --- Linux (systemd user unit) ---
if command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"

  # Copy and patch ExecStart path
  sed "s|%h/.local/bin/revdev-daemon|$DAEMON_BIN|g" \
    "$SCRIPT_DIR/revdev-daemon.service" > "$UNIT_DIR/revdev-daemon.service"

  systemctl --user daemon-reload
  systemctl --user enable revdev-daemon.service
  systemctl --user start revdev-daemon.service

  echo "Installed systemd user service."
  echo "  Status:  systemctl --user status revdev-daemon"
  echo "  Logs:    journalctl --user -u revdev-daemon -f"
  echo "  Stop:    systemctl --user stop revdev-daemon"
  exit 0
fi

# --- macOS (launchd) ---
if [ "$(uname)" = "Darwin" ]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$PLIST_DIR"
  PLIST_FILE="$PLIST_DIR/com.revealui.harness.plist"

  # Copy and patch ProgramArguments path
  sed "s|/usr/local/bin/revdev-daemon|$DAEMON_BIN|g" \
    "$SCRIPT_DIR/com.revealui.harness.plist" > "$PLIST_FILE"

  # Unload if previously loaded (ignore errors)
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  launchctl load "$PLIST_FILE"

  echo "Installed launchd agent."
  echo "  Status:  launchctl list | grep revealui"
  echo "  Logs:    tail -f /tmp/revealui-daemon.log"
  echo "  Stop:    launchctl unload $PLIST_FILE"
  exit 0
fi

echo "Error: Unsupported platform. Requires systemd (Linux) or launchd (macOS)."
exit 1
