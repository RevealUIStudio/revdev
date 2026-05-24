#!/usr/bin/env bash
# Install the systemd-user unit for revdev-daemon and enable it on boot.
#
# Usage:
#   ./packages/daemon/systemd/install.sh           # default: use repo path + PATH-resolved node
#   DAEMON_PATH=/opt/revdev ./install.sh           # override exec path
#   NODE_PATH=/opt/node-24/bin/node ./install.sh   # override node binary
#
# After install, manage with:
#   systemctl --user status revdev-daemon
#   systemctl --user restart revdev-daemon
#   journalctl --user-unit revdev-daemon -f
#
# WSL note: run `loginctl enable-linger $(whoami)` once on the host so
# systemd-user services survive logouts. Without lingering, the daemon
# stops when the last login session exits.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
DAEMON_PATH=${DAEMON_PATH:-$REPO_ROOT/packages/daemon/dist/cli.js}
# Resolve node binary at install time. systemd-user services run with a
# minimal PATH that typically excludes ~/.local/bin (where fnm + nvm + n
# shims live), so the unit template's `/usr/bin/env node` lookup fails
# at boot with exit 127. Bake the absolute path in instead.
# Override via NODE_PATH=/path/to/node for non-PATH installs or sandboxes.
NODE_PATH=${NODE_PATH:-$(command -v node || true)}
UNIT_DIR=${UNIT_DIR:-$HOME/.config/systemd/user}
TEMPLATE=$(dirname "$0")/revdev-daemon.service

if [ ! -f "$DAEMON_PATH" ]; then
  echo "error: daemon binary not found at $DAEMON_PATH" >&2
  echo "run 'pnpm --filter @revdev/daemon build' first" >&2
  exit 1
fi

if [ -z "$NODE_PATH" ]; then
  echo "error: 'node' not found on PATH (and NODE_PATH not set)" >&2
  echo "either install node or pass NODE_PATH=/path/to/node ./install.sh" >&2
  exit 1
fi

if [ ! -x "$NODE_PATH" ]; then
  echo "error: NODE_PATH ($NODE_PATH) is not executable" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
# Substitute the resolved NODE_PATH + DAEMON_PATH into the unit file. Both
# are wrapped in double quotes so paths with whitespace (e.g. WSL repos
# under `/mnt/c/Users/<name with space>/...`) survive systemd's argv
# parsing. Escape any special chars that would break the sed replacement
# (forward slashes are fine because we use `|` as the sed delimiter; the
# real risk is `&` and the quote char itself).
ESCAPED_NODE=$(printf '%s\n' "$NODE_PATH" | sed 's/[&"]/\\&/g')
ESCAPED_PATH=$(printf '%s\n' "$DAEMON_PATH" | sed 's/[&"]/\\&/g')
sed "s|/usr/bin/env node %h/revfleet/revdev/packages/daemon/dist/cli.js|\"$ESCAPED_NODE\" \"$ESCAPED_PATH\"|" \
  "$TEMPLATE" > "$UNIT_DIR/revdev-daemon.service"

systemctl --user daemon-reload
systemctl --user enable --now revdev-daemon

echo
echo "revdev-daemon installed at $UNIT_DIR/revdev-daemon.service"
echo "node: $NODE_PATH"
echo "exec: $DAEMON_PATH"
echo
echo "Status:"
systemctl --user status revdev-daemon --no-pager | head -10 || true
echo
echo "Tail logs with: journalctl --user-unit revdev-daemon -f"
echo "If on WSL and you want survival across logouts: sudo loginctl enable-linger \$(whoami)"

# --- License rotation timer (calendar, weekly) ----------------------------
# Additive: installs the rotation oneshot + timer using the same NODE_PATH +
# repo resolution as the daemon unit above. A second daemon-reload is harmless.
ROTATION_SERVICE_TEMPLATE=$(dirname "$0")/revdev-license-rotation.service
ROTATION_TIMER_TEMPLATE=$(dirname "$0")/revdev-license-rotation.timer
ROTATION_SCRIPT=$REPO_ROOT/scripts/rotate-license.ts
ESCAPED_SCRIPT=$(printf '%s\n' "$ROTATION_SCRIPT" | sed 's/[&"]/\\&/g')

if [ -f "$ROTATION_SERVICE_TEMPLATE" ] && [ -f "$ROTATION_TIMER_TEMPLATE" ]; then
  sed "s|/usr/bin/env node --import tsx %h/revfleet/revdev/scripts/rotate-license.ts|\"$ESCAPED_NODE\" --import tsx \"$ESCAPED_SCRIPT\"|" \
    "$ROTATION_SERVICE_TEMPLATE" > "$UNIT_DIR/revdev-license-rotation.service"
  cp "$ROTATION_TIMER_TEMPLATE" "$UNIT_DIR/revdev-license-rotation.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now revdev-license-rotation.timer
  echo
  echo "license-rotation timer installed at $UNIT_DIR/revdev-license-rotation.timer"
  echo "Next run:"
  systemctl --user list-timers revdev-license-rotation.timer --no-pager | head -3 || true
else
  echo
  echo "note: license-rotation unit templates not found alongside this script; skipped"
fi
