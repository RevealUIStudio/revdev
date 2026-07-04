# Getting Started with RevDev Studio

RevDev Studio is a native desktop app for AI agent coordination. It connects to the RevDev Harness Daemon for multi-agent session management, file reservations, task coordination, and local inference.

---

## System Requirements

| Platform | Minimum | Recommended |
|----------|---------|-------------|
| macOS | 12 Monterey (Apple Silicon or Intel) | 14 Sonoma |
| Linux | Ubuntu 22.04 / Fedora 38 | Ubuntu 24.04 |
| Windows | 10 21H2 (64-bit) | 11 23H2 |

Additional:
- 4 GB RAM minimum (8 GB recommended)
- 500 MB disk space
- Node.js 24+ (for the daemon)

---

## Installation

### 1. Download Studio

Download the latest release for your platform from [GitHub Releases](https://github.com/RevealUIStudio/revdev/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `RevealUI-Studio_x.x.x_aarch64.dmg` |
| macOS (Intel) | `RevealUI-Studio_x.x.x_x64.dmg` |
| Linux (Debian/Ubuntu) | `RevealUI-Studio_x.x.x_amd64.deb` |
| Linux (AppImage) | `RevealUI-Studio_x.x.x_amd64.AppImage` |
| Windows | `RevealUI-Studio_x.x.x_x64-setup.exe` |

> **macOS note:** the macOS `.dmg` builds are currently unsigned / ad-hoc, so Gatekeeper blocks the first launch. **Right-click the app → Open** (or approve it under `System Settings → Privacy & Security → Open Anyway`) once; subsequent launches work normally. Signed/notarized macOS builds are planned. In-app auto-update is not live yet — grab new versions from the Releases page manually for now.

### 2. Install the Harness Daemon

The daemon is the coordination brain — Studio connects to it for all agent operations.

```bash
# Clone the repo
git clone https://github.com/RevealUIStudio/revdev.git
cd revdev

# Install dependencies
pnpm install

# Build the daemon
pnpm --filter @revdev/daemon build

# Build the MCP bridge (needed for the "Using with an MCP-compatible AI
# coding tool" step below — it produces packages/bridge/dist/index.js)
pnpm --filter @revdev/bridge build

# Symlink the binary
mkdir -p ~/.local/bin
ln -sf "$(pwd)/packages/daemon/dist/cli.js" ~/.local/bin/revdev-daemon
chmod +x ~/.local/bin/revdev-daemon

# Install as a system service (auto-starts, auto-restarts on crash)
bash packages/daemon/service/install.sh
```

### 3. Verify the Daemon

```bash
# Check service status
systemctl --user status revdev-daemon   # Linux
launchctl list | grep revealui          # macOS

# Test socket connectivity
echo '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}' | \
  socat - UNIX-CONNECT:~/.local/share/revealui/harness.sock
# Expected: {"jsonrpc":"2.0","id":1,"result":{"pong":true,...}}
```

### 4. Launch Studio

Open the downloaded app. On first launch:
- Studio connects to the daemon automatically via Unix socket
- The status indicator in the sidebar shows green when connected
- If the daemon isn't running, Studio shows "Disconnected" and retries with backoff

---

## License Activation

RevDev operates in **Free (degraded) mode** without a license. Free mode allows:
- Session management (register, list, end)
- Daemon health checks
- Ping/connectivity

To unlock Pro features (agent spawning, inference, merge pipeline, memory, coordination):

1. Purchase a license at [revealui.com/pro](https://revealui.com/pro)
2. You'll receive a license key starting with `eyJ` — an Ed25519-signed JWT (RFC 7519, `alg: EdDSA`), a three-part `<header>.<payload>.<signature>` token.
3. Set it as an environment variable:

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
export REVEALUI_LICENSE_KEY="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJ0aWVyIjoicHJvIiwuLi59.<signature>"
```

The daemon ships with the vendor public key baked in, so it verifies your license with no further configuration.

**Advanced (key rotation / override):** `REVDEV_LICENSE_PUBLIC_KEY` overrides the baked-in vendor key with a PEM-encoded Ed25519 public key. You only need it if the vendor signing key has rotated and your build predates the rotation, or you are testing against your own keypair. The current public key is shown on your account page at [revealui.com/account/license](https://revealui.com/account/license).

```bash
export REVDEV_LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----"
```

4. Restart the daemon:

```bash
systemctl --user restart revdev-daemon
```

5. Verify activation:

```bash
journalctl --user -u revdev-daemon | grep "running with"
# Expected: "[license] RevDev daemon running with PRO license"
# If you instead see "running in FREE (degraded) mode", the key or the
# public key is missing/invalid — see TROUBLESHOOTING.md › License Issues.
```

### License Tiers

| Tier | Features |
|------|----------|
| **Free** | Session management, ping, health checks |
| **Pro** | + Agent spawning, mail, tasks, file reservations, merge pipeline |
| **Max** | + Local inference management, agent memory, advanced coordination |
| **Enterprise** | + All features, custom domains, SSO (planned) |

---

## First Session

Once Studio is connected to the daemon:

1. **Dashboard** — Shows active agent sessions, pending tasks, and file reservations
2. **Agent Panel** — Spawn and manage AI agents (requires Pro license)
3. **Terminal** — Embedded terminal with SSH bookmarks
4. **Git** — Status, diff, commit, branch management
5. **Vault** — Secret management via revvault integration
6. **Deploy** — Multi-step deployment wizard (Vercel, Neon, Stripe, Email)

### Using with an MCP-compatible AI coding tool

RevDev's MCP Bridge exposes the daemon to any MCP-compatible AI coding tool (Claude Code, Codex, Cursor, Windsurf, or custom agents). For example, with Claude Code:

```json
// In your MCP client config (Claude Code shown as an example):
{
  "revdev": {
    "command": "node",
    "args": ["path/to/revdev/packages/bridge/dist/index.js"]
  }
}
```

This gives the tool access to agent coordination, file reservations, and task management.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REVEALUI_LICENSE_KEY` | (none) | License key for Pro+ features — an `eyJ`-prefixed Ed25519 JWT |
| `REVDEV_LICENSE_PUBLIC_KEY` | (none) | PEM Ed25519 public key the daemon verifies the license against. Required for activation — without it the daemon stays in Free mode |
| `REVDEV_DAEMON_SOCKET` | `~/.local/share/revealui/harness.sock` | Socket path |
| `REVDEV_DAEMON_DATA` | `~/.local/share/revealui` | Database directory |
| `REVDEV_DAEMON_PID` | `~/.local/share/revealui/harness.pid` | PID file path |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama inference endpoint |

### Daemon Management

```bash
# View logs
journalctl --user -u revdev-daemon -f

# Stop daemon
systemctl --user stop revdev-daemon

# Start daemon
systemctl --user start revdev-daemon

# Restart (picks up env changes)
systemctl --user restart revdev-daemon

# Disable auto-start
systemctl --user disable revdev-daemon
```

---

## Auto-Updates

Studio checks for updates automatically on launch. When an update is available:
- A dialog appears showing the new version and changelog
- Click "Install" to download and apply
- Studio restarts with the new version

Updates are signed and verified — tampered binaries are rejected.

To check manually: use the "Check for Updates" command in Studio settings.

---

## Next Steps

- [Troubleshooting](./TROUBLESHOOTING.md) — Common issues and fixes
- [API Reference](./API_REFERENCE.md) — All 36 daemon RPC methods
- [Architecture](../CLAUDE.md) — How Studio, Daemon, and Bridge connect
