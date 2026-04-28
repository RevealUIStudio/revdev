#!/usr/bin/env bash
# Install the systemd-user unit for revdev-daemon and enable it on boot.
#
# Usage:
#   ./packages/daemon/systemd/install.sh           # default: use repo path
#   DAEMON_PATH=/opt/revdev ./install.sh           # override exec path
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
UNIT_DIR=${UNIT_DIR:-$HOME/.config/systemd/user}
TEMPLATE=$(dirname "$0")/revdev-daemon.service

if [ ! -f "$DAEMON_PATH" ]; then
  echo "error: daemon binary not found at $DAEMON_PATH" >&2
  echo "run 'pnpm --filter @revdev/daemon build' first" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
# Substitute the resolved DAEMON_PATH into the unit file.
sed "s|/usr/bin/env node %h/suite/revdev/packages/daemon/dist/cli.js|/usr/bin/env node $DAEMON_PATH|" \
  "$TEMPLATE" > "$UNIT_DIR/revdev-daemon.service"

systemctl --user daemon-reload
systemctl --user enable --now revdev-daemon

echo
echo "revdev-daemon installed at $UNIT_DIR/revdev-daemon.service"
echo "exec: $DAEMON_PATH"
echo
echo "Status:"
systemctl --user status revdev-daemon --no-pager | head -10 || true
echo
echo "Tail logs with: journalctl --user-unit revdev-daemon -f"
echo "If on WSL and you want survival across logouts: sudo loginctl enable-linger \$(whoami)"
