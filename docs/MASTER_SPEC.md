---
type: master-spec
repo: revdev
last-updated: 2026-05-10
owner: RevealUI Studio
staleness-status: FRESH
---

# RevDev — Master Spec

**Last Updated:** 2026-05-10
**Status:** Pre-1.0 — daemon production-grade for studio internal use; Studio + Console builds clean; no public releases
**Repo:** [RevealUIStudio/revdev](https://github.com/RevealUIStudio/revdev)

> Surface area, architecture, JSON-RPC contract. Companion to [`MASTER_PLAN.md`](./MASTER_PLAN.md) (status + roadmap).

---

## Mission

Native developer tools for RevealUI. **One product, two interfaces, one daemon.** Studio (Tauri 2) and Console (Go SSH TUI) are different UIs over the same JSON-RPC harness daemon. The daemon coordinates AI agents, manages PTY sessions, and routes tools to the RevealUI API.

---

## Repository structure

```
revdev/
├── README.md
├── CLAUDE.md                       # agent context
├── NOTICE.md                       # third-party attributions
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml
├── apps/
│   ├── studio/                     # Tauri 2 + React 19 desktop app
│   └── console/                    # Go + Bubble Tea SSH TUI
├── packages/
│   ├── daemon/                     # @revdev/daemon — Node.js JSON-RPC server (PGlite + Unix socket)
│   ├── protocol/                   # @revdev/protocol — TypeScript types for JSON-RPC contract
│   ├── bridge/                     # @revdev/bridge — Tauri↔daemon IPC adapter
│   └── theme/                      # @revdev/theme — shared visual tokens
├── scripts/
│   └── issue-license.ts            # CLI for issuing per-customer Ed25519 JWT licenses
├── docs/                           # this directory
├── config/                         # shared config (Biome, TS, etc.)
└── biome.json
```

### Package boundaries

| Package | Public name | Responsibility |
|---|---|---|
| `daemon` | `@revdev/daemon` | JSON-RPC server, PGlite persistence, agent session lifecycle, license validation, harness pruning |
| `protocol` | `@revdev/protocol` | TypeScript types for every RPC method (single source of truth for the contract) |
| `bridge` | `@revdev/bridge` | Tauri-side adapter: serializes RPC calls from Studio's React UI through Tauri IPC to the daemon socket |
| `theme` | `@revdev/theme` | Shared color + spacing tokens between Studio + Console |

### App boundaries

| App | Tech | UI surface |
|---|---|---|
| `studio` | Tauri 2 + React 19 | Desktop dashboard — agent health, session viewer, deploy wizard, billing surface, alerts |
| `console` | Go + Bubble Tea | SSH-friendly TUI — same surfaces over a terminal protocol; for production triage |

Studio and Console NEVER talk to each other. Both talk to the daemon over JSON-RPC.

---

## Architecture

```
┌─────────┐     ┌──────────┐
│ Studio  │     │ Console  │
│ (Tauri) │     │   (Go)   │
└────┬────┘     └────┬─────┘
     │   JSON-RPC    │
     └──────┬────────┘
            │
    ┌───────┴─────────┐
    │ Harness Daemon  │
    │   (Node.js)     │
    └───────┬─────────┘
            │
    ┌───────┴─────────┐
    │  RevealUI API   │
    │ (Hono/Vercel)   │
    └─────────────────┘
```

### Transport

- **Studio ↔ Daemon**: Tauri IPC on the studio side; daemon-side it's a Unix socket at `~/.local/share/revealui/harness.sock`
- **Console ↔ Daemon**: Direct Unix socket connection
- **Daemon ↔ RevealUI API**: HTTPS over the public RevealUI deployment (Vercel) or self-hosted Fleet kit

### Persistence

- **Daemon-local**: PGlite at `~/.local/share/revealui/` — agent sessions, mail, files reservation, tasks, events log, license cache
- **Cross-machine**: NOT YET WIRED (GAP-154) — daemon's PGlite-only model is the active gap; future Neon `coordination_*` table sync will allow multi-workstation coordination

### Process model

Daemon runs:
- **Best-practice (post-[revdev#27](https://github.com/RevealUIStudio/revdev/pull/27))** — systemd-user unit at `packages/daemon/systemd/revdev-daemon.service`; install via `pnpm --filter @revdev/daemon setup:systemd`; survives logout via `loginctl enable-linger`
- **Manual self-detach** — `node packages/daemon/dist/cli.js --detach`; child runs in own session/PGID; logs at `~/.local/share/revealui/daemon.log` (mode 0700)
- **Legacy fallback** — `setsid nohup node packages/daemon/dist/cli.js > /tmp/revdev-daemon.log 2>&1 < /dev/null & disown`

Memory limits ([revdev#32](https://github.com/RevealUIStudio/revdev/pull/32)): `MemoryHigh=800M` + `MemoryMax=1G` in systemd unit (sized to observed peak ~780 MiB; ~20 MiB cushion to MemoryHigh; ~31% headroom to MemoryMax).

---

## JSON-RPC surface

The daemon exposes 45+ methods. Categories:

| Category | Methods | Purpose |
|---|---|---|
| `session.*` | `register`, `attach`, `list`, `end` | Logical agent identity lifecycle |
| `mail.*` | `send`, `inbox`, `archive`, `subscribe` | Inter-agent messaging |
| `files.*` | `reserve`, `release`, `list-reservations` | Advisory file-locking for conflict prevention |
| `tasks.*` | `claim`, `complete`, `list`, `release` | Task queue across agent sessions |
| `events.*` | `log`, `tail`, `subscribe` | Audit + observability |
| `harness.*` | `prune`, `stats`, `health`, `version` | Daemon ops; `prune` is the periodic stale-session sweep ([revdev#23](https://github.com/RevealUIStudio/revdev/pull/23)) |
| `ping` | — | Liveness check; returns `{pong: true, ...}` |

### Health check

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | nc -U ~/.local/share/revealui/harness.sock
# → {"jsonrpc":"2.0","id":1,"result":{"pong":true,...}}
```

### Stale-session pruning

| Env var | Default | Purpose |
|---|---|---|
| `REVDEV_STALE_THRESHOLD_DAYS` | 7 | Sessions older than N days marked stale |
| `REVDEV_HARD_DELETE_DAYS` | (configurable) | Hard-delete after N days |

Hourly setinterval sweeps stale rows from `agent_sessions` table.

---

## License model

Per `packages/daemon/src/license.ts` + `license-crypto.ts`:

- **Format**: JWT, 3-part split (header.payload.sig)
- **Algorithm**: EdDSA (Ed25519) per Phase A migration ([revealui#735](https://github.com/RevealUIStudio/revealui/pull/735), 2026-05-04) + Phase B daemon acceptance ([revdev#42](https://github.com/RevealUIStudio/revdev/pull/42), 2026-05-04)
- **Hand-decode replacement**: `verifyLicenseJWT()` uses `node:crypto.verify(null, ...)`; zero new deps; ~30 LOC
- **Rejection reasons**: dotted-v2 (legacy), v1 (RVUI-*), invalid formats, RS256-JWT (algorithm mismatch — explicit pre-Phase-A regression test), JWT signed with wrong key, JWT with non-JSON payload, unrecognized tier, expired JWT, 2-part malformed JWT
- **Acceptance**: perpetual JWT (no exp), non-perpetual JWT with valid exp
- **Tiers** (whitelist): `free` / `pro` / `max` / `enterprise`
- **Detection branch** in `checkLicense()`: `if (key.startsWith('eyJ'))` — JWT path; legacy formats rejected with stderr message pointing customer at API/CLI for fresh JWT

License signing key lives in RevVault at `revdev/license-signing-key`.

---

## CLI surface

| CLI | Path | Purpose |
|---|---|---|
| `revdev-daemon` | `packages/daemon/dist/cli.js` | Daemon process; `--detach` flag |
| `revdev issue-license` | `scripts/issue-license.ts` | Issue per-customer Ed25519 JWT (matches Phase A payload schema for API-CLI parity) |
| `revdev` (TUI) | `apps/console` (Go binary) | SSH TUI ops cockpit |

---

## CI surface

`.github/workflows/`:

| Workflow | Triggers | Purpose |
|---|---|---|
| `ci.yml` | push + PR | Quality, Typecheck, Build, Test, Console (Go), Dependency Review, Secret Scanning, Submodule Audit |
| `codeql.yml` | push + PR | CodeQL js-ts + go |
| `studio-release.yml` | tag | Studio Tauri build (defined; not yet cutting public releases) |

All actions SHA-pinned (per [revdev#28](https://github.com/RevealUIStudio/revdev/pull/28)).

---

## Studio surface

Tauri 2 desktop app at `apps/studio/`. UI panels:

| Panel | Backed by |
|---|---|
| Dashboard (agent health, session list) | `useHealth` hook polling daemon `harness.health` (test-mocked via `vi.mock('../../lib/health-api')` per [revdev#43](https://github.com/RevealUIStudio/revdev/pull/43)) |
| Session viewer | Streaming subscribe to `events.tail` for the selected session |
| Deploy wizard | Multi-step flow; current StepEmail is a stub silently setting `setTestSent(true)` (TODO Phase 2) |
| Billing | RevealUI API consumer for billing surface |
| Alerts | Subscribes to `events.subscribe` for alert-tagged events |

Test count: 522/522 passing per [revdev#43](https://github.com/RevealUIStudio/revdev/pull/43).

---

## Security posture

- **Unix socket** with mode `srw-------` (owner-only) — daemon binds at `~/.local/share/revealui/harness.sock` with `umask 077`
- **Stale socket recovery** — `startDaemon()` unlinks any stale socket before binding (server.ts:606)
- **License keypair** in RevVault (never in env vars or `.env` files)
- **JWT verify** uses `node:crypto.verify(null, ...)` — Node built-in crypto, no third-party JWT lib (avoids algorithm-confusion CVE class)
- **CodeQL js-ts + go** scanning in CI
- **Gitleaks** + secret scanning + dependency review in CI

---

## Versioning

Pre-1.0 per the fleet versioning convention (RevealUI Studio internal). Per-package SemVer (`@revdev/daemon`, `@revdev/protocol`, `@revdev/bridge`, `@revdev/theme` independent). Studio + Console app versions tracked separately per Tauri / Go release conventions.

---

## Compose / coexistence

| Other product | Relationship |
|---|---|
| **RevealUI** | Daemon talks to RevealUI API for tool routing; license JWT issued by RevealUI's `packages/core/src/license.ts:521-543` `generateLicenseKey()` |
| **RevVault** | License signing key at `revdev/license-signing-key`; per-customer license keys may be stored under `credentials/license/<customer>` |
| **RevCon** | Studio integrates with RevCon for editor configs |
| **RevForge** | Stamped Fleet kits include a per-customer license JWT (Phase 3 integration); RevForge `stamp.sh` will eventually call `revdev issue-license` |
| **RevKit / RevealCoin / RevSkills** | Independent |

---

## See also

- [`docs/MASTER_PLAN.md`](./MASTER_PLAN.md) — current status, phases, owner action queue
- [`docs/PRODUCTION_LAUNCH_PLAN.md`](./PRODUCTION_LAUNCH_PLAN.md) — task-level launch checklist
- [`docs/API_REFERENCE.md`](./API_REFERENCE.md) — JSON-RPC API reference
- [`docs/GETTING_STARTED.md`](./GETTING_STARTED.md) — quick start
- [`docs/KEY_GENERATION.md`](./KEY_GENERATION.md) — license keypair generation
- [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — common issues
- [`CLAUDE.md`](../CLAUDE.md) — agent context
- [`README.md`](../README.md) — overview + architecture
- [`revealui:.claude/rules/hooks-architecture.md`](https://github.com/RevealUIStudio/revealui/blob/main/.claude/rules/hooks-architecture.md) — fleet hook contract; the daemon's role in fleet coordination
- Fleet master index (`MASTER_INDEX.md` in the RevealUI Studio internal coordination hub) — fleet-level navigation
