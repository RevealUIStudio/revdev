# RevDev — Production Launch Plan

Complete spec for remaining work to ship RevDev as a commercial product.
Covers both agent-executable (code) and human-required (secrets, accounts, infrastructure) tasks.

Last updated: 2026-04-20

---

## Status After PRs #18 + #19

| Capability | Status |
|---|---|
| Ed25519 license validation | Integrated (needs keypair) |
| Feature-based method gating | Done |
| Structured JSON logging | Done |
| Prometheus metrics + health checks | Done |
| Socket timeout + retry (Tauri bridge) | Done |
| Exponential backoff (watcher) | Done |
| Daemon process supervisor (systemd/launchd) | Done (needs install) |
| Tauri auto-updater plugin | Integrated (needs signing key) |
| E2E IPC tests (8 tests) | Done |
| Third-party NOTICE file | Done |
| Studio frontend status field | Done |

---

## Remaining Work — Agent (Code)

Tasks that can be completed by Claude Code in future sessions.

### A1. Zod Input Validation on RPC Dispatch

**Priority**: P1  
**Effort**: 3-5 days  
**Branch**: `feat/rpc-input-validation`

Add schema validation to all RPC method params using Zod:

```
packages/daemon/src/
├── validation/
│   ├── schemas.ts       — Zod schemas for every RPC method's params
│   ├── index.ts         — validateParams(method, params) dispatcher
│   └── limits.ts        — MAX_BODY_LENGTH, MAX_PATH_LENGTH, etc.
```

**Requirements**:
- Define Zod schema per RPC method (session.register, mail.send, tasks.create, etc.)
- Reject with JSON-RPC -32602 (invalid params) if validation fails
- Enforce max string lengths: subject (500), body (50KB), file_path (4096)
- Whitelist file_path prefixes (must be under a project directory, no `../`)
- Add `@revealui/contracts` as dependency for shared agent/task schemas
- Wire `validateParams()` into server.ts dispatch before handler call

**Verification**:
- Unit tests for each schema (valid + invalid inputs)
- Integration test: send oversized body → get -32602
- Integration test: path traversal attempt → rejected

---

### A2. Database Migration System for PGlite

**Priority**: P1  
**Effort**: 2-3 days  
**Branch**: `feat/daemon-migrations`

Replace `CREATE TABLE IF NOT EXISTS` with versioned sequential migrations:

```
packages/daemon/
├── migrations/
│   ├── 0001_initial_schema.sql   — current SCHEMA_SQL content
│   └── 0002_*.sql                — future schema changes
├── src/storage/
│   ├── migrate.ts                — migration runner
│   └── schema.ts                 — (keep for reference, no longer executed directly)
```

**Requirements**:
- Add `schema_version` table: `(version INT PRIMARY KEY, applied_at TIMESTAMP)`
- On startup: read current version → apply pending migrations in order
- Each migration file is a single SQL string (like Drizzle pattern in @revealui/db)
- If migration fails: log error, refuse to start (fail-fast, don't corrupt)
- Add `revdev-daemon migrate` CLI subcommand for manual migration
- Add `revdev-daemon migrate --status` to show current version

**Verification**:
- Test: fresh DB → all migrations applied → version = N
- Test: existing DB at version 1 → only 2+ applied
- Test: invalid SQL in migration → daemon refuses to start with clear error

---

### A3. HTTP Gateway for Remote Daemon Access

**Priority**: P2  
**Effort**: 1 week  
**Branch**: `feat/http-gateway`

Implement the HTTP server that `config.ts` already declares (httpPort, httpHost):

```
packages/daemon/src/
├── http.ts             — HTTP server (Hono or raw http module)
├── http-auth.ts        — Pairing code authentication
```

**Requirements**:
- Listen on `httpPort` when > 0 (default: disabled)
- Bridge HTTP JSON-RPC requests to the same handler registry
- Authentication: 6-digit pairing code displayed on daemon start
  - Client sends code in `Authorization: Bearer <code>` header
  - Code expires after 5 minutes or first successful auth
  - After auth: issue session token (JWT, 24h expiry)
- Rate limiting: 10 req/s per IP (use in-memory counter)
- CORS: allow `https://studio.revealui.com` origin
- Health endpoint: `GET /health` → same as `harness.health` RPC
- Metrics endpoint: `GET /metrics` → Prometheus text format (requires auth)

**Verification**:
- `curl http://localhost:PORT/health` → 200 with health JSON
- Unauthenticated RPC → 401
- Pairing code auth → 200 + session token
- Rate limit exceeded → 429

---

### A4. Studio UI for Daemon Status + Lifecycle

**Priority**: P2  
**Effort**: 2-3 days  
**Branch**: `feat/studio-daemon-panel`

Add UI components that use the new `daemon_ctl` Tauri commands and `status` field:

```
apps/studio/src/components/infrastructure/
├── DaemonStatusBadge.tsx    — Shows connected/connecting/disconnected
├── DaemonControlPanel.tsx   — Start/Stop/Restart buttons
```

**Requirements**:
- Show daemon status in the sidebar/status bar (green/yellow/red dot)
- "Start Daemon" button (calls `daemon_start`)
- "Stop Daemon" button (calls `daemon_stop`, confirm dialog)
- "Restart Daemon" button (calls `daemon_restart`)
- Show PID and uptime when connected
- Show last error message when disconnected
- Auto-hide controls if daemon is managed by systemd/launchd (detect via PID file owner)

**Verification**:
- Stop daemon → badge turns red, "Start" button appears
- Click "Start" → badge turns green within 5s
- Kill daemon process → badge transitions through "connecting" → "disconnected"

---

### A5. Rust Integration Tests (Cargo)

**Priority**: P2  
**Effort**: 2-3 days  
**Branch**: `feat/rust-integration-tests`

Add Rust-side integration tests that exercise the Tauri bridge against a real daemon:

```
apps/studio/src-tauri/tests/
├── harness_integration.rs   — Full RPC round-trip tests
├── daemon_ctl_integration.rs — Start/stop lifecycle tests
```

**Requirements**:
- Tests start a daemon on `REVDEV_TEST_SOCKET` (env var added in PR #18)
- `full_rpc_round_trip`: register → create task → claim → complete
- `timeout_when_unreachable`: no daemon → error within timeout window
- `retry_on_transient_failure`: daemon starts after 1s → succeeds
- `daemon_start_stop`: start via `daemon_ctl::daemon_start` → ping → stop → verify dead
- Add `cargo test` step to CI workflow

**Verification**:
- `cd apps/studio/src-tauri && cargo test` — all pass
- CI green with new test step

---

### A6. Console Productization (if selling Console)

**Priority**: P3 (skip if Studio-only launch)  
**Effort**: 1 week  
**Branch**: `feat/console-release`

**Requirements**:
- Public binary on GitHub Releases (already have `console-release.yml`)
- Homebrew formula: `brew install revealui/tap/revdev-console`
- Fly.io deployment config (persistent SSH server)
- Connect Console to daemon via HTTP gateway (not Unix socket)
- Add monitoring/logging (structured output to stdout for Fly.io)
- Update README with installation + deployment guide

---

## Remaining Work — Human (Manual Setup)

Tasks that require the founder's credentials, physical access, or business decisions.

### H1. Generate Tauri Signing Keypair

**Priority**: P0 (BLOCKS auto-update)  
**Effort**: 15 minutes  
**Who**: Founder

```bash
cd ~/suite/revdev/apps/studio/src-tauri
pnpm tauri signer generate -w ~/.tauri/revdev-studio.key
```

Then:
1. Copy the **public key** into `tauri.conf.json` → `plugins.updater.pubkey`
2. Store the **private key** in revvault: `revvault set revdev/tauri-signing-private-key`
3. Add as GitHub secret: `TAURI_SIGNING_PRIVATE_KEY` (value from revvault)
4. Add password as GitHub secret: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

**Verification**: `pnpm tauri info` shows updater configured with non-empty pubkey.

---

### H2. Generate License Signing Keypair (RS256)

**Priority**: P0 (BLOCKS license enforcement)  
**Effort**: 30 minutes  
**Who**: Founder

```bash
# Generate RSA-2048 keypair for license JWT signing
openssl genrsa -out /tmp/license-private.pem 2048
openssl rsa -in /tmp/license-private.pem -pubout -out /tmp/license-public.pem

# Store in revvault
revvault set revdev/license-signing-private-key < /tmp/license-private.pem
revvault set revdev/license-signing-public-key < /tmp/license-public.pem

# Clean up plaintext
rm /tmp/license-private.pem /tmp/license-public.pem
```

Then:
1. Set `REVEALUI_LICENSE_PUBLIC_KEY` in daemon environment (production)
2. Set in CI for integration tests that need Pro+ access
3. Add the public key to the Studio binary (embed in `tauri.conf.json` or resource)

---

### H3. Issue First License Keys

**Priority**: P0 (BLOCKS first sale)  
**Effort**: 30 minutes  
**Who**: Founder (after H2)

Use `@revealui/core/license`'s `generateLicenseKey()` function:

```typescript
import { generateLicenseKey } from '@revealui/core/license';
import { readFileSync } from 'node:fs';

const privateKey = readFileSync('/path/to/private.pem', 'utf-8');

// Generate a Pro license for a customer (1 year expiry)
const key = await generateLicenseKey(
  { tier: 'pro', customerId: 'customer-uuid', maxSites: 5 },
  privateKey,
  365 * 24 * 60 * 60, // 1 year in seconds
);

console.log(key); // JWT string — deliver to customer
```

Create a CLI script at `scripts/issue-license.ts` for repeatable key generation.

---

### H4. Set Up Release Endpoint for Auto-Update

**Priority**: P1 (BLOCKS auto-update delivery)  
**Effort**: 1-2 hours  
**Who**: Founder

Options (pick one):
- **GitHub Releases** (simplest): Tauri action already uploads artifacts; just need `latest.json` generated per platform
- **S3 + CloudFront**: Upload `latest.json` to `releases.revealui.com/studio/{target}/{arch}/`
- **Vercel Edge**: Simple edge function that proxies GitHub Release assets

The Tauri updater plugin automatically generates `latest.json` during the release build if `TAURI_SIGNING_PRIVATE_KEY` is set. Just ensure the endpoint URL in `tauri.conf.json` resolves to the correct file.

**Verification**: `curl https://releases.revealui.com/studio/linux-x86_64/latest.json` → valid JSON with version + signature.

---

### H5. Configure GitHub Secrets for CI

**Priority**: P1  
**Effort**: 15 minutes  
**Who**: Founder

Add these secrets to `RevealUIStudio/revdev` → Settings → Secrets:

| Secret | Source | Used By |
|--------|--------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | H1 (revvault) | `studio-release.yml` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | H1 | `studio-release.yml` |
| `APPLE_CERTIFICATE` | Apple Developer account | macOS code signing |
| `APPLE_CERTIFICATE_PASSWORD` | Apple Developer account | macOS code signing |
| `APPLE_ID` | founder@revealui.com | Notarization |
| `APPLE_PASSWORD` | App-specific password | Notarization |
| `APPLE_TEAM_ID` | Apple Developer account | Notarization |

**Note**: Apple secrets only needed for macOS builds. Linux/Windows work without them.

---

### H6. Install Daemon Service on Dev Machine

**Priority**: P1 (for dogfooding)  
**Effort**: 5 minutes  
**Who**: Founder

```bash
cd ~/suite/revdev

# Build daemon
pnpm --filter @revdev/daemon build

# Symlink binary
ln -sf "$(pwd)/packages/daemon/dist/cli.js" ~/.local/bin/revdev-daemon
chmod +x ~/.local/bin/revdev-daemon

# Install service (auto-detects systemd on WSL)
bash packages/daemon/service/install.sh

# Verify
systemctl --user status revdev-daemon
```

---

### H7. Apple Developer Account (macOS distribution)

**Priority**: P2 (BLOCKS macOS sales)  
**Effort**: 1-2 days (Apple review)  
**Who**: Founder

- Enroll in Apple Developer Program ($99/year) if not already
- Create Developer ID Application certificate
- Generate app-specific password for notarization
- Export certificate as .p12 and store in revvault

---

### H8. Windows Code Signing Certificate

**Priority**: P2 (BLOCKS Windows sales)  
**Effort**: 1-3 days (CA issuance)  
**Who**: Founder

Options:
- **EV Certificate** (best UX, no SmartScreen warnings): ~$300/year from DigiCert/Sectigo
- **OV Certificate** (cheaper, some initial SmartScreen friction): ~$100/year
- **Azure Trusted Signing** (newer, no hardware token): Microsoft program

Store certificate + password in revvault.

---

### H9. Pricing Page + Purchase Flow

**Priority**: P1 (BLOCKS revenue)  
**Effort**: 1-2 days  
**Who**: Founder

- Add RevDev pricing to revealui.com/pricing (or separate page)
- Wire Stripe checkout for Pro/Max/Enterprise tiers
- On successful payment: call `generateLicenseKey()` → deliver to customer
- Store license records in RevealUI database (`licenses` table exists in @revealui/db)

---

### H10. User Documentation

**Priority**: P1  
**Effort**: 2-3 days  
**Who**: Founder + Agent

Create docs at `apps/studio/docs/` or on revealui.com/docs/revdev:

| Page | Contents |
|------|----------|
| Getting Started | Download, install, first run |
| Daemon Setup | Service installation, configuration |
| License Activation | Where to paste key, tier features |
| Agent Coordination | How multi-agent workflow works |
| Troubleshooting | Common errors, daemon won't start, logs location |
| API Reference | All 75 RPC methods with params/response |

---

## Launch Sequence (Recommended Order)

```
Week 1:  H1 + H2 + H5 + H6           (signing keys, CI secrets, dogfood)
Week 1:  A1 (Zod validation)          (agent work, parallel with above)
Week 2:  A2 (migrations)              (agent work)
Week 2:  H4 (release endpoint)        (founder)
Week 2:  H9 (pricing + Stripe)        (founder)
Week 3:  H3 (first license keys)      (founder, after H2)
Week 3:  H10 (docs)                   (founder + agent)
Week 3:  A4 (Studio daemon panel)     (agent work)
Week 4:  First signed release build   (tag studio-v0.1.0)
Week 4:  H7 or H8 (code signing)      (founder, platform-specific)
Week 4:  Announce + first sale
---
Post-launch:
  A3 (HTTP gateway)                    (enables remote daemon)
  A5 (Rust integration tests)          (test coverage)
  A6 (Console productization)          (if selling Console)
```

---

## Definition of Done (Shippable Product)

All of these must be true before first commercial sale:

- [ ] H1: Tauri signing keypair generated and in GitHub secrets
- [ ] H2: License RS256 keypair generated and in revvault
- [ ] H3: Can generate valid customer JWT that unlocks Pro features
- [ ] H4: Auto-update endpoint serves `latest.json`
- [ ] H5: CI secrets configured for code-signed builds
- [ ] H6: Daemon running as service on dev machine (dogfood)
- [ ] H9: Customer can purchase and receive license key
- [ ] H10: Minimum docs exist (install + activate + troubleshoot)
- [ ] A1: RPC params validated (no unbounded input attacks)
- [ ] A2: Database migrations work (schema can evolve)
- [ ] First signed Studio build published to GitHub Releases
- [ ] Auto-update verifiably works (v0.1.0 → v0.1.1 update)
- [ ] Daemon restarts automatically after crash (verified on dev machine)

---

## Post-Launch Priorities

| Priority | Work | Type |
|----------|------|------|
| P1 | Windows SmartScreen certificate | Human |
| P1 | macOS notarization | Human |
| P2 | HTTP gateway for remote daemon | Agent |
| P2 | Studio daemon control panel | Agent |
| P2 | Rust integration test suite | Agent |
| P3 | Console productization | Agent + Human |
| P3 | Telemetry (opt-in crash reports) | Agent |
| P3 | Customer license portal (self-service) | Agent + Human |
