---
type: plan
repo: revdev
last-updated: 2026-06-11
owner: RevealUI Studio
staleness-status: FRESH
---

# RevDev — Plan

**Last Updated:** 2026-06-11 (statuses verified against code, merged PRs, and CI on this date)
**Status:** Pre-1.0 — Studio + Console + harness daemon all buildable; no public releases yet
**Owner:** RevealUI Studio (`founder@revealui.com`)

> **The single RevDev plan.** [`MASTER_PLAN.md`](./MASTER_PLAN.md) is the stable entry point that references this file; the spec counterpart is [`SPEC.md`](./SPEC.md) (referenced by [`MASTER_SPEC.md`](./MASTER_SPEC.md)). This file absorbs and supersedes the former `PRODUCTION_LAUNCH_PLAN.md` (removed 2026-06-11) with every task status re-verified.

---

## Verified state (2026-06-11)

| Component | Status | How to get it today |
|---|---|---|
| Studio | Buildable, unsigned | `pnpm --filter studio tauri build` — local binary. `studio-release.yml` defined; no public releases cut (updater pubkey not yet configured). |
| Console | Buildable | `cd apps/console && go build -o ../../rvui .` — no root `go.mod`; module lives under `apps/console/`. `console-release.yml` defined; no releases cut. |
| Harness daemon | Buildable, not published | `pnpm --filter @revdev/daemon build`; CLI at `packages/daemon/dist/cli.js`. Runs locally under systemd-user. |

What is true today (each item verified, not carried forward):

- **test→main promotion is flowing.** Latest promotion [#97](https://github.com/RevealUIStudio/revdev/pull/97) merged 2026-06-10 (prior: #93, #86). The earlier "promotion blocked on the russh/libcrux CVE chain" state is resolved — `russh = "0.60"` is current in `apps/studio/src-tauri/Cargo.toml`.
- **License toolchain is Ed25519 JWT only.** `scripts/issue-license.ts` emits RFC 7519 JWTs (`alg: EdDSA`); the daemon rejects all legacy formats (`RVUI.v2.*`, `RVUI-*`) with explicit reasons (`packages/daemon/src/license.ts`). The signing keypair **exists** in the vault at the canonical paths `revdev/license-signing-{private,public}-key` (consolidated 2026-06-10; legacy single-key paths deleted).
- **Daemon license lifecycle is production-shaped.** Expiry warnings (14d/7d/1d) + fail-closed start + `REVDEV_LICENSE_PUBLIC_KEY_FILE` support ([#88](https://github.com/RevealUIStudio/revdev/pull/88)); rotation script + weekly systemd timer ([#90](https://github.com/RevealUIStudio/revdev/pull/90)); signature verified before expiration check ([#94](https://github.com/RevealUIStudio/revdev/pull/94)).
- **Per-RPC identity Phase 1 is shipped.** `agent_identity` / `agent_identity_keys` / `agent_identity_nonces` tables, DID bootstrap on `session.register`, and accept-if-present signature verification are in the daemon (`packages/daemon/src/server.ts`, `storage/schema.ts`, DID + crypto test suites). Phases 2–4 pending — see W2.
- **RPC input validation is shipped** (former launch-plan task A1): every method has a Zod schema at `packages/daemon/src/validation/schemas.ts`.
- **Studio dogfood Phase 1 is shipped, Phases 2–4 are not.** `apps/studio` consumes `@revealui/presentation` `^0.6.0` tokens; the 10-file shadow library at `apps/studio/src/components/ui/` still exists with its ~94 import sites — see W4.
- **Open issues:** [#15](https://github.com/RevealUIStudio/revdev/issues/15) Studio deploy-email test step is a stub (needs durable SMTP probe), [#2](https://github.com/RevealUIStudio/revdev/issues/2) HTTP gateway (see W3 — the design has moved).

---

## Workstreams

### W1 — Commercial launch readiness

Everything between today and the first commercial sale. Split agent-executable vs owner-required, exactly one status per task.

**Agent tasks (code):**

| # | Task | Status (2026-06-11) | Notes |
|---|---|---|---|
| A1 | Zod input validation on RPC dispatch | ✅ **SHIPPED** | `packages/daemon/src/validation/schemas.ts`; invalid params → `-32602`. |
| A2 | Versioned migration system for PGlite | **OPEN — P1** | Daemon still runs a single `SCHEMA_SQL` with `CREATE TABLE IF NOT EXISTS` (`src/storage/schema.ts`); no `migrations/` dir. Build: `schema_version` table, sequential `migrations/000N_*.sql`, fail-fast on error, `revdev-daemon migrate [--status]` subcommands. Verify: fresh DB applies all; existing DB applies only pending; bad SQL refuses to start. |
| A3 | HTTP gateway for remote daemon access | **SUPERSEDED by W3 design** | Tracked as [#2](https://github.com/RevealUIStudio/revdev/issues/2). The GAP-154 Phase 5 design recommends a *server-mediated* cross-machine path rather than every daemon hosting public HTTP — do not implement a daemon-hosted gateway before the W3 architecture decision is ratified. |
| A4 | Studio UI for daemon status + lifecycle | ✅ **SHIPPED** | `apps/studio/src/components/infrastructure/{DaemonPanel,InfrastructurePanel}.tsx`. Before closing permanently, confirm start/stop/restart controls cover the systemd-managed case. |
| A5 | Rust integration tests (Tauri bridge ↔ real daemon) | **OPEN — P2** | `apps/studio/src-tauri/tests/` does not exist. Build: round-trip, timeout-when-unreachable, retry-on-transient, daemon start/stop lifecycle; add `cargo test` to CI. |
| A6 | Console productization | **OPEN — P3** | Skip for a Studio-only launch. GitHub Releases binary (`console-release.yml` exists), Homebrew formula, deployment recipe, structured logging. Connect via the W3 transport, not a bespoke socket bridge. |

**Owner tasks (credentials, accounts, decisions):**

| # | Task | Status (2026-06-11) | Notes |
|---|---|---|---|
| H1 | Generate Tauri updater signing keypair | **OPEN — P0, blocks auto-update** | `tauri.conf.json` → `plugins.updater.pubkey` is still `""`. `pnpm tauri signer generate -w ~/.tauri/revdev-studio.key`; public key into `tauri.conf.json`; private key into the vault; add `TAURI_SIGNING_PRIVATE_KEY{,_PASSWORD}` repo secrets. |
| H2 | Generate license signing keypair (Ed25519) | ✅ **DONE 2026-06-10** | Canonical pair lives at `revdev/license-signing-{private,public}-key`; prod env carries it. Remaining tail: embed the public key in the Studio binary (resource or `tauri.conf.json`) and mirror to CI if integration tests need Pro+ gating. Runbook: [`KEY_GENERATION.md`](./KEY_GENERATION.md). |
| H3 | Issue first customer licenses | **READY — awaiting first sale** | `pnpm exec tsx scripts/issue-license.ts --tier pro --customer "<name>" --days 365` (or `--perpetual`). Output is an Ed25519-signed JWT; customer sets it as `REVEALUI_LICENSE_KEY`. (The old `RVUI.v2.…` wording in the retired launch plan was wrong — the daemon rejects that format.) |
| H4 | Release endpoint for auto-update | **OPEN — P1** | Pick GitHub Releases (simplest) vs S3/CloudFront vs edge proxy; `tauri.conf.json` already points at `releases.revealui.com/studio/{{target}}/{{arch}}/latest.json`. |
| H5 | CI secrets for signed builds | **OPEN — P1** | `TAURI_SIGNING_PRIVATE_KEY{,_PASSWORD}` (from H1) + Apple cert/notarization set (from H7). Linux/Windows builds work without the Apple set. |
| H6 | Daemon service on dev machine | ✅ **DONE** | systemd-user unit installed + running (closed 2026-04-28 via [#27](https://github.com/RevealUIStudio/revdev/pull/27) + [#23](https://github.com/RevealUIStudio/revdev/pull/23)). |
| H7 | Apple Developer account + certs | **OPEN — P2, blocks macOS distribution** | Developer ID cert, app-specific password, .p12 into the vault. |
| H8 | Windows code-signing certificate | **OPEN — P2, blocks Windows distribution** | EV vs OV vs Azure Trusted Signing; store cert + password in the vault. |
| H9 | Pricing page + purchase flow | **OPEN — P1, owner-gated** | RevDev pricing on the public pricing surface + checkout + on-payment license issuance (`licenses` table exists in the RevealUI database). Gated on the owner's commercial-launch decision. |
| H10 | User documentation | **PARTIAL** | [`GETTING_STARTED.md`](./GETTING_STARTED.md), [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md), [`API_REFERENCE.md`](./API_REFERENCE.md), [`KEY_GENERATION.md`](./KEY_GENERATION.md) exist in-repo. Remaining: customer-facing install/activate docs on the public docs site. |

**Definition of done (first commercial sale):**

- [x] License Ed25519 keypair generated + vaulted (H2)
- [x] Daemon running as a service on the dev machine, dogfooded (H6)
- [x] RPC params validated — no unbounded-input attacks (A1)
- [x] Daemon restarts automatically after crash (systemd `Restart=on-failure`)
- [ ] Tauri signing keypair generated + in repo secrets (H1)
- [ ] Customer license key verifiably unlocks Pro features end-to-end (H3 dry-run)
- [ ] Auto-update endpoint serves `latest.json` (H4) and an update verifiably applies (v0.1.0 → v0.1.1)
- [ ] CI secrets configured; first signed Studio build published (H5 + release)
- [ ] Customer can purchase and receive a license (H9)
- [ ] Minimum customer docs exist: install + activate + troubleshoot (H10)
- [ ] Database migrations work so the schema can evolve post-launch (A2)

### W2 — Daemon identity: DID + Ed25519 per-RPC signing (Phases 2–4)

Decision record: internal ADR `2026-05-16-revdev-did-ed25519-rpc-signing` (the public security-limitations disclosure names this work as the planned remediation for socket-bound identity).

| Phase | Scope | Status |
|---|---|---|
| P1 | Identity tables, DID bootstrap on register, vault-backed keys, accept-if-present verification | ✅ **SHIPPED** (in daemon since 2026-05-16; on `main` via promotion #97) |
| P2 | Telemetry: per-RPC signature-status events; observe ≥95% valid-signature rate across 7 days | **NEXT** |
| P3 | Enforce: non-exempt RPCs without a valid signature fail (`-32099`); revertible via `REVDEV_REQUIRE_SIGNATURE` | Pending P2 acceptance |
| P4 | Remove legacy socket-bound identity fallback | Pending 30 days clean P3 |

Phases gate on acceptance criteria, not calendar. Envelope + DID format: [`SPEC.md`](./SPEC.md) §Identity.

### W3 — Cross-machine coordination (GAP-154 Phase 5) — DEFERRED, owner unblocks

Phases 0–4 are shipped: best-effort daemon→Neon dual-write for sessions/mail/files/tasks/events ([#25](https://github.com/RevealUIStudio/revdev/pull/25), [#26](https://github.com/RevealUIStudio/revdev/pull/26)) plus the admin read surface in the RevealUI server (revealui#651). The remaining gap is the **cross-machine transport**: daemon on host A reaching an agent on host B with verifiable identity and revocable trust.

- **Recommended architecture (pending owner ratification): server-mediated.** The RevealUI server gains authenticated `POST /v1/coordination/{mail,files,tasks,events}` + `GET /v1/coordination/peers`; daemons POST signed envelopes (W2 DIDs) outbound; revocation is a single DB row. A daemon-hosted public HTTP listener (the original [#2](https://github.com/RevealUIStudio/revdev/issues/2) shape) was evaluated and rejected for v1: per-daemon TLS/DNS/NAT burden and a much larger attack surface.
- **Planned shape: 3 PRs.** (1) server write API + peer registry + pairing-token issuance/revocation; (2) daemon outbox table + outbound HTTP client + `daemon.peers` RPC, signed-envelope first with pairing-code bootstrap; (3) docs rewrite + 2-machine smoke runbook + gap closure.
- **Open questions for the owner before execution:** ratify server-mediated vs daemon-hosted; pairing-code-only acceptable for v1 or require signed envelopes; peer-poll interval default (60s proposed).
- **Status: deferred** until single-machine coordination no longer suffices for a real customer; the owner triggers execution. Acceptance criteria live in the internal GAP-154 tracker (the YAML is the source of truth).

### W4 — Studio dogfood: adopt `@revealui/presentation`

Phase 1 (token foundation) shipped 2026-05-16 via [#67](https://github.com/RevealUIStudio/revdev/pull/67)/[#68](https://github.com/RevealUIStudio/revdev/pull/68): Studio imports `@revealui/presentation/tokens.css` and inherits the fleet brand automatically. Remaining, in order:

| Phase | Scope | Status |
|---|---|---|
| 2 | Shim the 10 shadow primitives in `apps/studio/src/components/ui/` as thin wrappers over `@revealui/presentation` (5 PRs, lowest fan-out first: StatusDot+PanelHeader → Tooltip+ErrorAlert+Badge → Modal+Dialog → Input → Button+Card). Consumer code unchanged. | **OPEN** |
| 3 | Sweep the ~19 bespoke `orange-*` brand sites in render code to semantic tokens; `rg 'orange-' apps/studio/src` → zero. | OPEN (after Phase 2) |
| 4 | Delete the shadow library + add a Biome `noRestrictedImports` guard so it cannot return. | OPEN (after Phase 3) |

Carve-outs that stay: `codemirror`/`@codemirror/*` (editor) and `@xterm/*` (terminal) — domain primitives with no fleet equivalent. Operational sequencing for this workstream lives in the internal `studio-dogfood` lane; this table is the product-plan view.

### W5 — Console

- **Release pipeline (Phase 3 of releases):** Go cross-compile matrix + GitHub Releases via `console-release.yml`; Brew tap/Scoop optional. Not started.
- **RevealUI-side rename tail:** `apps/server` route `terminal-auth` → `console-auth` with a deprecation alias, landed together with the DNS dual-CNAME owner action (`terminal.` → `console.` host). Lives in the RevealUI repo; tracked here because Console is the consumer.
- **Open question (owner):** does Console belong in revdev, or in the RevealUI monorepo? Console is a customer ops surface (licenses/credits/alerts); RevDev is dev tooling. Revisit when Console productization (A6) starts.

### W6 — Public releases

| Release | Gates |
|---|---|
| Studio v0.1.0 (signed) | H1 + H4 + H5; macOS additionally H7, Windows additionally H8. First tag exercises `studio-release.yml` end-to-end. |
| Console v0.1.0 | A6 + `console-release.yml` first tag. |
| Daemon on npm | Not planned until after first Studio release; daemon ships embedded today. |

---

## Dogfood milestones (owner using RevDev daily)

- [x] Daemon as the fleet's live coordination backbone (sessions/mail/files/tasks/events RPCs in daily agent use)
- [x] Studio dev launch under WSLg (verified working 2026-05-07)
- [ ] Prebuilt Studio release artifact installed and self-updating (gated on H1/H4)
- [ ] A full work session driven from Studio (editor + agents + terminal) instead of a terminal-only session
- [ ] One ops task handled exclusively through Console over SSH

## Exit criteria (product)

1. Two or more coding agents coordinate work via the harness daemon without human relay; messages are injected automatically into agent context.
2. Studio shows live agent status and supports message compose.
3. File conflicts are detected and surfaced before they cause merge issues.
4. Studio and Console build and release from this repo with native CI pipelines.
5. A paying customer can purchase, activate (JWT license), and auto-update.

---

## Owner action queue (consolidated)

| # | Item | Unblocks | Priority |
|---|---|---|---|
| 1 | H1 Tauri updater keypair | Auto-update, W6 | **P0** |
| 2 | H4 release-endpoint decision + H5 CI secrets | First signed release | P1 |
| 3 | H9 pricing + purchase flow decision | Revenue | P1 (owner-gated) |
| 4 | W3 architecture ratification (server-mediated) | Cross-machine coordination | On demand |
| 5 | H7 Apple / H8 Windows certs | Platform distribution | P2 |
| 6 | W5 Console-home decision | Console productization | P3 |

## References

- [`SPEC.md`](./SPEC.md) — consolidated spec (architecture, JSON-RPC contract, license model, identity)
- [`MASTER_PLAN.md`](./MASTER_PLAN.md) / [`MASTER_SPEC.md`](./MASTER_SPEC.md) — stable entry points
- [`KEY_GENERATION.md`](./KEY_GENERATION.md) — signing-key runbook · [`API_REFERENCE.md`](./API_REFERENCE.md) · [`GETTING_STARTED.md`](./GETTING_STARTED.md) · [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- Internal (private coordination hub): fleet master plan §RevDev, GAP-154 tracker, ADR `2026-05-16-revdev-did-ed25519-rpc-signing`, `studio-dogfood` lane, license rotation policy.
