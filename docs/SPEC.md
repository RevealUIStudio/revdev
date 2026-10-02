---
type: spec
repo: revdev
last-updated: 2026-08-19
owner: RevealUI Studio
staleness-status: FRESH
---

# RevDev — Spec

**Last Updated:** 2026-08-19
**Status:** Pre-1.0 — daemon production-grade for internal use; Studio + Console build clean; public tags `studio-v0.2.11` and `console-v0.2.0` exist

> **The single RevDev spec** — surface area, architecture, JSON-RPC contract, license model, identity. [`MASTER_SPEC.md`](./MASTER_SPEC.md) is the stable entry point that references this file. Plan counterpart: [`PLAN.md`](./PLAN.md).

---

## Mission

Native developer tools for RevealUI. **One product, two interfaces, one daemon.** Studio (Tauri 2) and Console (Go SSH TUI) are different UIs over the same JSON-RPC harness daemon. The daemon coordinates AI agents, manages PTY sessions, and routes tools to the RevealUI API.

---

## Repository structure

```
revdev/
├── README.md
├── .revealui/README.md             # agent context
├── NOTICE.md                       # third-party attributions
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml
├── apps/
│   ├── studio/                     # Tauri 2 + React 19 desktop app
│   └── console/                    # Go + Bubble Tea SSH TUI
├── packages/
│   ├── daemon/                     # @revdev/daemon — Node.js JSON-RPC server (PGlite + Unix socket)
│   ├── protocol/                   # @revdev/protocol — TypeScript types for the JSON-RPC contract
│   ├── bridge/                     # @revdev/bridge — Tauri↔daemon IPC adapter
│   └── theme/                      # @revdev/theme — shared visual tokens
├── scripts/
│   ├── issue-license.ts            # Authenticated hosted registered license issuance
│   └── rotate-license.ts           # Calendar + emergency license rotation (manual, on demand)
├── docs/                           # this directory
└── config/                         # shared config (Biome, TS, etc.)
```

### Third-party attribution

`pnpm notice:generate` and `pnpm notice:check` use the maintained generator.
Installed grants and notices are the primary source. If a Node artifact omits
its grant, `scripts/notice-source-policy.json` declares the upstream repository,
package manifest, and original license paths. These paths are accepted only
when the pinned npm signature verifier returns valid SLSA provenance whose
package subject digest matches the exact pnpm lock integrity. The certified signer must be a GitHub workflow in that same repository. The attested Git
commit, source package name/version/license/repository, and regular source files
must all agree. Installed copyright notices are retained alongside source grants.

pnpm remains the only dependency resolver. npm performs signature verification
against a disposable projection of the existing lock; it never installs or
resolves a second graph. Public verification subprocesses exclude operator
credentials. Every installed Node source is checked; attribution failures are
reported together and prevent replacing `NOTICE.md`. Successfully retrieved
grants emit a receipt containing the locked artifact integrity, source commit,
and original file URLs, byte lengths, and SHA-256 hashes. These receipts establish
individual source retrieval, not complete NOTICE coverage.
`is-node-process@1.2.0` has no authenticated source grant and remains a blocker.

### Package boundaries

| Package | Public name | Responsibility |
|---|---|---|
| `daemon` | `@revdev/daemon` | JSON-RPC server, PGlite persistence, agent session lifecycle, license validation, agent identity, harness pruning |
| `protocol` | `@revdev/protocol` | TypeScript types for every RPC method — single source of truth for the contract |
| `bridge` | `@revdev/bridge` | Tauri-side adapter: serializes RPC calls from Studio's React UI through Tauri IPC to the daemon socket |
| `theme` | `@revdev/theme` | Shared color + spacing tokens between Studio + Console |

### App boundaries

| App | Tech | UI surface |
|---|---|---|
| `studio` | Tauri 2 + React 19 | Desktop dashboard — agent health, session viewer, deploy wizard, billing surface, alerts, daemon lifecycle panel |
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
- **Console ↔ Daemon**: direct Unix socket connection
- **Daemon ↔ RevealUI API**: HTTPS to the public RevealUI deployment or a self-hosted Fleet kit
- **Cross-machine**: not yet wired — design is settled on a server-mediated path (signed envelopes via the RevealUI server), see [`PLAN.md`](./PLAN.md) §W3. The daemon deliberately hosts no public HTTP listener today.

### Persistence

- **Daemon-local (source of truth)**: PGlite at `~/.local/share/revealui/` — agent sessions, mail, file reservations, tasks, events log, license cache, agent identity
- **Fleet visibility**: best-effort dual-write of sessions/mail/files/tasks/events to Neon `coordination_*` tables (GAP-154 Phases 2–3, shipped). Failures never break the RPC — PGlite remains authoritative. The admin read surface lives in the RevealUI server.

### Process model

Daemon runs:

- **Best practice** — systemd-user unit at `packages/daemon/systemd/`; install via `pnpm --filter @revdev/daemon setup:systemd`; survives logout via `loginctl enable-linger`. Memory limits `MemoryHigh=800M` / `MemoryMax=1G` (sized to observed peak ~780 MiB).
- **Manual self-detach** — `node packages/daemon/dist/cli.js --detach`; child runs in its own session/PGID; logs at `~/.local/share/revealui/daemon.log` (dir mode 0700).
- **Legacy fallback** — `setsid nohup node packages/daemon/dist/cli.js > /tmp/revdev-daemon.log 2>&1 < /dev/null & disown`

Stale-socket recovery: the daemon unlinks any stale socket before binding.

---

## JSON-RPC surface

Method categories (the **authoritative method list** is `@revdev/protocol` plus the per-method Zod schemas at `packages/daemon/src/validation/schemas.ts` — every RPC method has one; invalid params are rejected with `-32602`):

| Category | Representative methods | Purpose |
|---|---|---|
| `session.*` | `register`, `attach`, `list`, `end`, `update` | Logical agent identity lifecycle; `register` also bootstraps the agent's DID (see §Identity) |
| `mail.*` | `send`, `inbox`, `broadcast`, `markRead` | Inter-agent messaging |
| `files.*` | `reserve`, `release`, `check`, `list` | Advisory file-locking for conflict prevention |
| `tasks.*` | `create`, `claim`, `complete`, `release`, `list` | Task queue across agent sessions (CAS claiming) |
| `events.*` | `log`, `query` | Audit + observability (no `tail`/`subscribe` RPC today) |
| `agent.*` | `spawn`, `stop`, `list`, `remove`, `input`, `resize`, `output` | PTY spawn under bwrap confinement (Pro; signature-required) |
| `project.*` / `file.*` / `git.*` | open/grant/revoke, read/write, status/commit/… | Single-repo I/O (Free; mutations signature-required) |
| `worktree.*` / `merge.*` | create/list/remove, request/status/list/update | Isolation + merge pipeline |
| `memory.*` | `store`, `query` | Full AI memory (**Max**) |
| `inference.*` | `status`, `chat`, `generate` (Free run); `pull`, `delete`, `start`, `stop` (**Max** management) | Local open-model inference |
| `harness.*` | `health`, `prune` only | Daemon ops; no `stats`/`version` RPC (use `ping` + package version) |
| `identity.rotate` | — | DID key rotation (signature-required) |
| `ping` | — | Liveness; returns `{pong: true, …}` |

Authoritative enumeration: `@revdev/protocol` `RPC_METHODS` ↔ daemon `listRegisteredMethods()` (rpc-contract test).

### Health check

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | nc -U ~/.local/share/revealui/harness.sock
# → {"jsonrpc":"2.0","id":1,"result":{"pong":true,...}}
```

### Stale-session pruning

| Env var | Default | Purpose |
|---|---|---|
| `REVDEV_STALE_THRESHOLD_DAYS` | 7 | Sessions older than N days marked stale |
| `REVDEV_HARD_DELETE_DAYS` | (env-tunable) | Hard-delete after N days |

Hourly sweep prunes stale rows from `agent_sessions`.

---

## Identity — DID + Ed25519 per-RPC signing

Socket-bound identity (agent binds at `session.register`, inherited per-socket) is being replaced by per-RPC cryptographic identity. Phase 1 is live; the full rollout is tracked in [`PLAN.md`](./PLAN.md) §W2.

- **DID format:** `did:revealfleet:<agentId>:<fingerprint>` where `fingerprint = base58btc(sha256(rawPublicKeyBytes))`. Internal-format DID only — no W3C DID resolution; other `did:` prefixes are rejected.
- **Keys:** Ed25519 via `node:crypto` (zero external crypto deps), generated on first `session.register` per agent; persisted to the vault (canonical) and mirrored to PGlite (`agent_identity`, `agent_identity_keys`) for fast lookup. `forceRotate: true` rotates with a grace window for the superseded key.
- **Envelope:** detached JWS-style, three base64url segments on an `x-revdev-signature` field beside the RPC frame. Header pins `alg: EdDSA`, `typ: revdev-rpc-sig-v1`, `kid: <DID>`. Payload signs `{method, params_hash, nonce, ts, agentId}` — `params_hash` is `sha256(canonicalJSON(params))`, so signed bytes stay ~200 B and verification short-circuits before params parsing.
- **Replay protection:** 128-bit nonce cache (`agent_identity_nonces`, PGlite-persisted, swept periodically) + timestamp window (`REVDEV_SIG_TS_WINDOW_MS`, default 60s); `ping` returns `serverTimeMs` for skew detection.
- **Current mode:** accept-if-present — signatures are verified when sent, absence falls back to socket-bound identity. Enforcement (`REVDEV_REQUIRE_SIGNATURE`) and removal of the fallback land as W2 P3/P4.
- **Exempt boundary:** health/inference methods need no identity; `session.register` is bootstrap-exempt for first contact; everything that claims or mutates agent-private state requires identity (and post-P3, a valid signature).

Tier authorization is orthogonal: the DID proves *who* is calling, the license proves *what* they may call.

---

## License model

Per `packages/daemon/src/license.ts` + `license-crypto.ts` + `scripts/issue-license.ts`:

- **Format:** Ed25519-signed JWT (RFC 7519), header `{ alg: "EdDSA", typ: "JWT" }`. Detection: keys starting `eyJ` take the JWT path.
- **Legacy formats are rejected** — `RVUI.v2.*` (dotted v2) and `RVUI-*` (v1) fail with an explicit message directing the holder to obtain a fresh JWT. Also rejected with named reasons: RS256/wrong-algorithm JWTs, wrong-key signatures, non-JSON payloads, unrecognized tiers, malformed 2-part tokens. <!-- doclint:allow-legacy-format -->
- **Verification:** `node:crypto.verify(null, …)` — no third-party JWT library (avoids the algorithm-confusion CVE class). Signature is verified **before** the expiration check.
- **Acceptance:** a locally trusted signed perpetual JWT (no `exp`), or dated JWT with valid expiry, plus fresh exact-token hosted registration for each new paid dispatch. Local signature validity alone does not authorize paid dispatch.
- **Tiers (whitelist):** `free` / `pro` / `max` / `enterprise`. Feature gating via the daemon's license guard.
- **Lifecycle:** the daemon warns at 14d/7d/1d before expiry and **fails closed** (refuses to start) on a present-but-expired license. The daemon obtains issuer trust from the fixed hosted license authority for each paid authorization; customers set their license as `REVEALUI_LICENSE_KEY`.
- **Authority:** the existing hosted signer and authenticated licensing API own issuance, exact-token registration, idempotent operation receipts and containment. Independent local signing is retired. Paid dispatch requires a fresh online check and fails closed during outages; in-flight admitted work may finish. Issuer-trust migration and maintained Vault expected-current promotion remain activation blockers.

### License principals — founder vs customer

Two-principal model (convention-based today, "Approach A"):

- **Founder/staff principal** — `tier: enterprise`, `customer: "RevealUIStudio"`. Used when working *on* the product.
- **Customer principal** — e.g. `tier: pro`, `customer: "<account>"`. Used when dogfooding *as* a customer: exercises real upgrade/expiry/revocation flows without locking the founder out, and keeps founder usage out of customer metrics.

Tier is the pricing axis; principal type is orthogonal — staff-ness is **not** a tier. The planned end state ("Approach B") adds an explicit optional `internal: boolean` JWT claim, triggered the first time a staff-only code path needs to gate on principal type; existing licenses remain valid (`internal` defaults to false). Rotation cadence and operational policy for the studio's own licenses live in the internal license rotation policy, not in this public spec.

---

## CLI surface

| CLI | Path | Purpose |
|---|---|---|
| `revdev-daemon` | `packages/daemon/dist/cli.js` | Daemon process; `--detach` flag; systemd installer via `setup:systemd` |
| `issue-license` | `scripts/issue-license.ts` | Authenticated hosted issuance; explicit customer and stable operation UUID; Vault promotion additionally requires explicit mode and a recover-first immutable operation receipt; conditional Vault creation requires an absent leaf and configured issuer trust |
| `rotate-license` | `scripts/rotate-license.ts` | Calendar/emergency rotation; explicit mode and stable operation UUID; recover-first original expectation followed by conditional Vault promotion; manual, on demand (timer retired 2026-07-26) |
| Console | `apps/console` (Go binary, `rvui`) | SSH TUI ops cockpit |

License promotion receipts record the declared request and the effective signed grant separately. A null declared limit means unspecified; it does not promise unlimited use. The issuer records any supported perpetual site default once, and recovery retains that original selection. The consumer validates the signed token against the recorded effective grant before conditional Vault promotion.

---

## CI surface

`.github/workflows/`: `ci.yml` (quality, typecheck, build, test, Console Go job, secret scanning), `codeql.yml` (js-ts + go), `dependency-review.yml` (PR-only), `promotion-gate.yml` (test→main gate), `backflow.yml` (auto main→test backflow PR, shared reusable workflow), gitleaks via pinned CLI, `studio-release.yml` (tag-triggered Tauri build; latest public tag `studio-v0.2.11`), `console-release.yml` (tag-triggered Go release; public tag `console-v0.2.0`). All third-party actions SHA-pinned.

---

## Studio surface

Tauri 2 desktop app at `apps/studio/`. UI panels:

| Panel | Backed by |
|---|---|
| Dashboard (agent health, session list) | `useHealth` polling daemon `harness.health` |
| Session viewer | Streaming subscribe to `events.tail` for the selected session |
| Deploy wizard | Multi-step flow; the email test step is a stub pending a durable SMTP probe ([#15](https://github.com/RevealUIStudio/revdev/issues/15)) |
| Billing | RevealUI API consumer |
| Alerts | Subscribes to `events.subscribe` for alert-tagged events |
| Infrastructure / Daemon | `components/infrastructure/{DaemonPanel,InfrastructurePanel}.tsx` — daemon status + lifecycle |

UI primitives: Studio consumes `@revealui/presentation` tokens (dogfood Phase 1); the legacy shadow library under `src/components/ui/` is being shimmed away per [`PLAN.md`](./PLAN.md) §W4. Durable carve-outs: `codemirror`/`@codemirror/*` (editor) and `@xterm/*` (terminal). The studio Vitest suite + typecheck + build gate PRs via `studio-release.yml`.

---

### Git diff reads

HEAD, index and working-tree diff reads return an explicit missing-entry result
for an absent Git version or tracked deletion. Studio maps verified missing
versions to empty and preserves present content, including zero-byte files.
Transport, authority, Git, malformed-response and
size failures propagate to the existing diff error boundary. Immutable blob
reads preserve UTF-8 content and trailing whitespace; literal pathspecs prevent
file names from selecting other entries. Unborn HEAD is distinguished from a
corrupt HEAD, and unmerged index entries remain errors.

### Deployment database target

Database setup requires an absolute RevealUI workspace directory and an explicit
PostgreSQL URL with host and database name. The tested target is held through
migration and seed confirmations; cancellation or failed testing runs neither
mutation. Native commands validate the workspace and supply the chosen URL to
both database environment keys used by its maintained scripts. An unmatched
pnpm database package filter is an error.

Connection testing passes a password-redacted URI as psql's explicit database
argument. URI passwords remain in the child environment; routing defaults from
ambient libpq settings cannot replace the target. Routing aliases in query
parameters are rejected, while SSL options remain supported. Confirmation shows
the project and host/database without credentials.

### Configuration persistence

Startup loads configuration before registering the store or starting background
watchers. Only a verified absent config file receives defaults. Read failures,
invalid JSON/UTF-8 and dangling links stop setup without replacing saved bytes.
An unavailable OS configuration directory is an error; the working directory
is never a fallback configuration location.

Set and reset hold the configuration lock while persisting a complete replacement.
The store publishes the new in-memory value only after persistence succeeds, so
a rejected change is neither exposed by `get_config` nor restored after restart. Configuration and Unix
managed-license files share the same atomic file writer: exclusive temporary
creation, complete write and file sync, then replacement in the destination
folder. Failed writes or publication retain the prior destination and clean up
the temporary file. Unix directories and new files are restricted before private
bytes are written. This does not assert power-loss durability of directory metadata.

## Security posture

- **Unix socket** mode `srw-------` (owner-only), bound under `umask 077`; stale sockets unlinked before bind
- **Per-RPC identity** (accept-if-present today, enforcement phased — §Identity); replay-protected signed envelopes
- **License keys in the vault**, never in env files; JWT verification via `node:crypto` only; signature checked before expiry; fail-closed on expired licenses
- **Zod validation on every RPC method** — bounded input, `-32602` on violation
- **CI:** CodeQL (js-ts + go), gitleaks, secret scanning, dependency review, SHA-pinned actions

---

## Versioning

Pre-1.0 per the fleet versioning convention. Per-package SemVer (`@revdev/daemon`, `@revdev/protocol`, `@revdev/bridge`, `@revdev/theme` independent). Studio + Console app versions tracked separately per Tauri / Go release conventions.

---

## Composition with the rest of RevealFleet

| Other product | Relationship |
|---|---|
| **RevealUI** | Daemon talks to the RevealUI API for tool routing; Studio is a UI over the same. RevDev is the dev-tools surface; RevealUI is the runtime. |
| License authority | Hosted signer owns private key; maintained provisioning must supply trusted public-key lifecycle and registered customer credential |
| **RevCon** | Studio integrates with RevCon for editor configs |
| **RevForge** | Stamped Fleet kits include a per-customer license JWT; RevForge's stamping flow will eventually call `issue-license` (Console-productization scope) |
| **RevKit / RevSkills** | Independent |

---

## See also

- [`PLAN.md`](./PLAN.md) — the single RevDev plan (workstreams, statuses, owner queue)
- [`MASTER_PLAN.md`](./MASTER_PLAN.md) / [`MASTER_SPEC.md`](./MASTER_SPEC.md) — stable entry points
- [`API_REFERENCE.md`](./API_REFERENCE.md) — JSON-RPC API reference
- [`GETTING_STARTED.md`](./GETTING_STARTED.md) · [`KEY_GENERATION.md`](./KEY_GENERATION.md) · [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`.revealui/README.md`](../.revealui/README.md) — agent context · [`README.md`](../README.md) — overview
