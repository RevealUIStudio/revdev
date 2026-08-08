# @revdev/daemon

Harness daemon — the coordination brain for RevDev.

Manages AI agent sessions, PTY processes, tool routing, inter-agent messaging, task coordination, and file reservations.

## Transport

- **Local**: Unix socket (`~/.local/share/revealui/harness.sock`)
- **Remote**: HTTP gateway with pairing-code auth (**shipped**, GAP-421 port of the
  harness gateway; GAP-154 Phase 5 transport + `daemon.peers` Neon registry). Off by default (`httpPort: 0`).
  When enabled: `GET/POST /api/pair` (HMAC challenge, secret never on the wire),
  `POST /rpc` (same `dispatchRpc` path as the Unix socket — one authorization
  plane), `GET /api/status`, `GET /api/stream/:processId` (ticket-bound SSE).
  Default bind is `127.0.0.1`; do not expose to untrusted networks without a
  reverse proxy and operator review.
- **Protocol**: JSON-RPC 2.0 over newline-delimited JSON (socket) or HTTP JSON body (`/rpc`)

## Running the daemon

### Foreground (development)

```bash
pnpm --filter @revdev/daemon build
pnpm --filter @revdev/daemon start
```

The daemon prints log lines to stdout/stderr and exits when the shell closes.

### Detached (one-shot, survives shell exit)

```bash
pnpm --filter @revdev/daemon start:detached
# or:
node packages/daemon/dist/cli.js --detach
```

The CLI re-spawns itself with `detached: true` (Linux: `setsid`), redirects
stdio to `REVDEV_DAEMON_LOG` (default `/tmp/revdev-daemon.log`), and the
parent exits immediately. The child runs in its own session/process group
so a shell logout (SIGHUP) doesn't kill it.

Stop a detached daemon by reading its PID file (`~/.local/share/revealui/harness.pid`)
and sending SIGTERM:

```bash
kill "$(cat ~/.local/share/revealui/harness.pid)"
```

### systemd-user (auto-start, auto-restart on crash)

```bash
pnpm --filter @revdev/daemon build
pnpm --filter @revdev/daemon setup:systemd
```

The setup script writes `~/.config/systemd/user/revdev-daemon.service`
pointed at the built `dist/cli.js`, then `daemon-reload + enable --now`.
After this, the daemon starts on user login and auto-restarts on crash.

Manage it:

```bash
systemctl --user status revdev-daemon
systemctl --user restart revdev-daemon
systemctl --user stop revdev-daemon
journalctl --user-unit revdev-daemon -f
```

**WSL note:** without `loginctl enable-linger`, systemd-user services
stop when the user's last login session exits. Run once on the host:

```bash
sudo loginctl enable-linger "$(whoami)"
```

After enabling lingering, the daemon survives WSL session closes, terminal
restarts, etc.

## Configuration

Environment variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `REVEALUI_LICENSE_KEY` | (none → FREE tier) | Ed25519-signed license. Pro+ unlocks coordination RPCs |
| `REVDEV_LICENSE_PUBLIC_KEY` | (none) | Public key matching the license signature |
| `REVDEV_DAEMON_SOCKET` | `~/.local/share/revealui/harness.sock` | Unix socket bind path |
| `REVDEV_DAEMON_DATA` | `~/.local/share/revealui` | PGlite data directory |
| `REVDEV_DAEMON_PID` | `~/.local/share/revealui/harness.pid` | PID file location |
| `REVDEV_DAEMON_LOG` | `~/.local/share/revealui/daemon.log` | Log file for `--detach` mode |
| `POSTGRES_URL` | (none → sync disabled) | Neon URL for cross-machine `coordination_*` sync (GAP-154) |

## License tiers

| Tier | Features |
|---|---|
| free | Session management only |
| pro | + agent spawning, merge pipeline, memory |
| max | + inference management, advanced coordination |
| enterprise | Full access |

## Smoke test

For local dev / smoke testing without a real license key, use the
Ed25519 test-license generator at
[`src/__tests__/test-license-helper.ts`](src/__tests__/test-license-helper.ts).
It produces a self-signed keypair on the fly and returns a license + public
key suitable for the `enterprise` tier. The integration test suite at
`src/__tests__/coordination.test.ts` shows the full pattern (call
`generateTestLicense('enterprise')`, then `setTestLicenseEnv(kit)` before
starting the daemon). Real licenses ship via revvault; do not check signed
keys into source.

Once a daemon is running:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | \
  nc -U ~/.local/share/revealui/harness.sock
# → {"jsonrpc":"2.0","id":1,"result":{"pong":true,...}}
```

## Architecture pointers

- `src/server.ts` — JSON-RPC dispatch, license guard, RPC handler registry, periodic stale-session prune (GAP-153).
- `src/storage/schema.ts` — PGlite schema (11 tables: agent_sessions, agent_messages, file_reservations, tasks, events, worktrees, agent_memory, merge_requests, agent_identity, agent_identity_keys, agent_identity_nonces).
- `src/neon.ts` — daemon → Neon dual-write helpers (GAP-154 Phases 2 + 3). Best-effort, no-op when `POSTGRES_URL` unset. Sessions, mail, files, tasks, events dual-write; `memory.*` / `merge.*` stay local-only until Neon schema grows (documented in-module).
- `src/http-gateway.ts` — TCP HTTP gateway + pairing + SSE (GAP-421 / GAP-154 Phase 5 transport). Off unless `httpPort > 0`.
- `src/gateway-store.ts` — durable gateway tokens + bootstrap secret hash.
- `src/guard.ts` — license tier check at RPC dispatch time.
- `systemd/revdev-daemon.service` — systemd-user unit template.
- `systemd/install.sh` — installer that resolves the unit's exec path and enables it.
