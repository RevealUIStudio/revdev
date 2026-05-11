---
type: master-plan
repo: revdev
last-updated: 2026-05-10
owner: RevealUI Studio
staleness-status: FRESH
---

# RevDev — Master Plan

**Last Updated:** 2026-05-10
**Status:** Pre-1.0 — Studio + Console + harness daemon all buildable; no public releases yet
**Owner:** RevealUI Studio (`founder@revealui.com`)
**Repo:** [RevealUIStudio/revdev](https://github.com/RevealUIStudio/revdev)
**Fleet master index:** [`revealui-jv:docs/MASTER_INDEX.md`](https://github.com/RevealUIStudio/revealui-jv/blob/main/docs/MASTER_INDEX.md)

> Fleet-level cross-cutting plans live in [`revealui-jv:docs/MASTER_PLAN.md`](https://github.com/RevealUIStudio/revealui-jv/blob/main/docs/MASTER_PLAN.md). This file is RevDev-scoped only.
>
> Detailed launch checklist (agent-executable + human-required tasks): [`docs/PRODUCTION_LAUNCH_PLAN.md`](./PRODUCTION_LAUNCH_PLAN.md). This MASTER_PLAN is the higher-level pointer; PRODUCTION_LAUNCH_PLAN is the per-task breakdown.

---

## Headline state

RevDev is **one product, two interfaces, one daemon**:

- **Studio** — Tauri 2 + React 19 desktop AI editor + agent coordination dashboard
- **Console** — Go + Bubble Tea SSH TUI ops cockpit (agent health, deploys, billing, alerts)
- **Harness daemon** (Node.js) — coordinates agents, manages PTY sessions, routes tools to RevealUI API. Studio + Console are different UIs for the same daemon.

All three components build cleanly today. None has cut a public release. Distribution maturity differs:

| Component | Status | How to get it today |
|---|---|---|
| Studio | Buildable, unsigned | `pnpm --filter studio tauri build` — produces a local binary. Signed/notarized auto-update pipeline defined in `.github/workflows/studio-release.yml` but not yet cutting public releases. |
| Console | Buildable | `cd apps/console && go build -o ../../rvui .` — no root `go.mod`; the console module lives under `apps/console/` (CI pattern at `.github/workflows/ci.yml:78-79`). No release automation yet. |
| Harness Daemon | Buildable, not published | Not on npm. Build from source: `pnpm --filter @revdev/daemon build`; run CLI at `packages/daemon/dist/cli.js`. |

---

## Current Reality (2026-05-10)

### What works (verified by recent merges + smoke tests)

- **Daemon JSON-RPC** — 45+ methods (`session.register`, `mail.*`, `files.*`, `tasks.*`, `events.log`, `harness.*`, etc.); PGlite-backed persistence at `~/.local/share/revealui/`
- **Daemon self-detach** ([revdev#27](https://github.com/RevealUIStudio/revdev/pull/27), 2026-04-28) — `--detach` CLI flag + systemd-user unit at `packages/daemon/systemd/`; child runs in own session/PGID
- **Agent-session pruning** ([revdev#23](https://github.com/RevealUIStudio/revdev/pull/23), 2026-04-28) — `harness.prune` RPC + setinterval hourly sweep; configurable via `REVDEV_STALE_THRESHOLD_DAYS` / `REVDEV_HARD_DELETE_DAYS`
- **Ed25519 license acceptance** ([revdev#42](https://github.com/RevealUIStudio/revdev/pull/42), 2026-05-04) — Phase B of license-ed25519 migration; daemon accepts JWT signed with EdDSA, rejects RS256/dotted-v2/wrong-algorithm with explicit reasons
- **Daemon memory limits** ([revdev#32](https://github.com/RevealUIStudio/revdev/pull/32)) — `MemoryHigh=800M` + `MemoryMax=1G` in systemd unit (sized to observed peak ~780 MiB)
- **CI hardening** — SHA-pinned all 41 actions across 6 workflow files (#28); pnpm fix (#22); dependency review; CodeQL js-ts + go; gitleaks; secret scanning
- **Studio dashboard test health** ([revdev#43](https://github.com/RevealUIStudio/revdev/pull/43), 2026-05-05) — `useHealth` initial-poll race fix; `vi.mock('../../lib/health-api')` mirroring billing-api pattern; 522/522 studio tests pass
- **Daemon at runtime today** — running under systemd-user, license=ENTERPRISE, ping pong:true; managed via systemd or legacy `setsid + nohup` recipe

### What does not exist yet

- **Public Studio release** — needs Apple notarization cert + Windows code-signing cert + auto-update server hosting decision
- **Public Console release** — `go build` + GitHub Releases pipeline pending
- **Daemon → Neon sync (GAP-154)** — daemon writes to local PGlite only; Neon `coordination_*` tables not yet receiving writes; cross-machine coordination not yet wired
- **Studio email send** — currently a stub that silently sets `setTestSent(true)` (`apps/studio/src/components/deploy/StepEmail.tsx:46`)
- **Test→main promotion** — `revdev:test` ahead of `main` since 2026-05-03 (PR #34 closed-deferred on real libcrux CVE chain via russh; resume when upstream russh ships SemVer-compatible upgrade including libcrux-ml-kem fix)

---

## Composition with the rest of RevFleet

| Other product | Relationship |
|---|---|
| **RevealUI** | Daemon talks to RevealUI API (Hono/Vercel) for tool routing; Studio is a UI over the same. RevDev is the dev-tools surface; RevealUI is the runtime. |
| **RevVault** | Daemon license-signing keys live in RevVault (`revdev/license-signing-key`) per [`secrets.md`](https://github.com/RevealUIStudio/revealui/blob/main/.claude/rules/secrets.md) |
| **RevCon** | Studio integrates with RevCon for editor configs (Zed/VS Code/Cursor synced via symlinks) |
| **RevKit** | Independent — RevKit provisions the workstation; RevDev runs on whatever workstation exists |
| **RevForge / RevealCoin / RevSkills** | Independent |

The daemon's coordination role for RevFleet agent sessions is documented in [`hooks-architecture.md`](https://github.com/RevealUIStudio/revealui/blob/main/.claude/rules/hooks-architecture.md). Hook coordination is daemon-up-best-effort; soft no-op when daemon down.

---

## Active Work

### Current branch: `fix/daemon-jwt-iss-aud-customerid` (clean)

Active on the daemon JWT validation surface — adding `iss` + `aud` + `customerId` validation per Phase B follow-up. No conflict with master-of-masters scaffold.

### Recently shipped (last ~2 weeks)

- **revdev#43** (2026-05-05) — Studio dashboard test health mock fix
- **revdev#42** (2026-05-04 merged) — Phase B license-ed25519 daemon acceptance + 11 negative tests
- **revdev#33** (2026-05-03 merged) — sync main→test absorbing CI hardening (SHA-pins + pnpm fix)
- **revdev#34** (2026-05-03 closed-deferred) — test→main promotion blocked on libcrux-sha3 CVE; resume on upstream russh upgrade
- **revdev#32** (2026-05-03 merged) — daemon systemd memory limits
- **revdev#31** (2026-05-03 merged) — fnm-PATH workaround in systemd unit
- **revdev#30 / #29 / #21** (2026-05-03) — license CLI consolidation across 3 PRs

---

## Roadmap

Detailed task-level breakdown in [`PRODUCTION_LAUNCH_PLAN.md`](./PRODUCTION_LAUNCH_PLAN.md). Higher-level phases below.

Pre-1.0 per [`versioning.md`](https://github.com/RevealUIStudio/revealui-jv/blob/main/.claude/rules/versioning.md).

### Phase 0 — Daemon production-grade (DONE)

JSON-RPC stable; PGlite persistence; auto-detach; systemd-user unit; agent-session pruning; Ed25519 license acceptance; memory limits sized; license=ENTERPRISE running locally.

### Phase 1 — Test→main promotion (BLOCKED on upstream)

Resume condition: upstream `russh` ships SemVer-compatible upgrade including `libcrux-ml-kem` ≥ a version with `libcrux-sha3` ≥ 0.0.8 (RUSTSEC-2026-0074 fix). Watch `cargo update -p russh` for SemVer-compatible upgrade. Until then, `test` is ahead of `main` honestly.

### Phase 2 — Public Studio release (NOT STARTED)

| Sub-phase | Status | Owner |
|---|---|---|
| Apple notarization cert | NOT STARTED | Human |
| Windows code-signing cert | NOT STARTED | Human |
| Auto-update server hosting | NOT STARTED | Human (decision) |
| Studio email-send: replace stub with real Gmail API call | NOT STARTED | Agent |

### Phase 3 — Public Console release (NOT STARTED)

| Sub-phase | Status |
|---|---|
| Cross-platform Go build matrix | NOT STARTED |
| GitHub Releases pipeline | NOT STARTED |
| Brew tap + Scoop bucket (optional) | NOT STARTED |

### Phase 4 — Cross-machine coordination (DEFERRED — GAP-154)

Daemon → Neon `coordination_*` tables sync; allows multiple workstations / cloud VMs to coordinate via the same daemon backend. Currently single-machine PGlite only.

---

## Owner Action Queue

| # | Item | Unblocks | Priority |
|---|---|---|---|
| 1 | Decide Studio distribution channel (revealui.com download vs GitHub Releases vs other) | Phase 2 | Medium |
| 2 | Procure Apple notarization + Windows code-signing certs | Phase 2 | Medium |
| 3 | Auto-update server hosting decision | Phase 2 | Medium |
| 4 | Watch `cargo update -p russh` for SemVer-compatible upgrade | Phase 1 unblock | Low |
| 5 | License-issuance flow integration with RevForge `stamp.sh` | Cross-product | Low (Phase 3 scope) |

---

## Known follow-up gaps

| Gap | Tracker | Status |
|---|---|---|
| Daemon → Neon coordination sync | GAP-154 | Open — large remaining gap |
| GAP-152 daemon self-detach + auto-start | [revdev#27](https://github.com/RevealUIStudio/revdev/pull/27) | **CLOSED** 2026-04-28 |
| GAP-153 stale `agent_sessions` row pruning | [revdev#23](https://github.com/RevealUIStudio/revdev/pull/23) | **CLOSED** 2026-04-28 (Phase 2 periodic prune) |
| Studio email-send stub | `apps/studio/src/components/deploy/StepEmail.tsx:46` | Open — Phase 2 sub-task |

---

## See also

- [`docs/MASTER_SPEC.md`](./MASTER_SPEC.md) — surface area, architecture, JSON-RPC method list
- [`docs/PRODUCTION_LAUNCH_PLAN.md`](./PRODUCTION_LAUNCH_PLAN.md) — task-level launch checklist (agent + human)
- [`docs/API_REFERENCE.md`](./API_REFERENCE.md) — API surface
- [`docs/GETTING_STARTED.md`](./GETTING_STARTED.md) — quick start
- [`docs/KEY_GENERATION.md`](./KEY_GENERATION.md) — license keypair gen
- [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — common issues
- [`README.md`](../README.md) — overview + architecture diagram
- [`CLAUDE.md`](../CLAUDE.md) — agent context
- [`revealui:.claude/rules/hooks-architecture.md`](https://github.com/RevealUIStudio/revealui/blob/main/.claude/rules/hooks-architecture.md) — RevDev daemon contract for fleet hooks
- [`revealui-jv:docs/MASTER_INDEX.md`](https://github.com/RevealUIStudio/revealui-jv/blob/main/docs/MASTER_INDEX.md) — fleet-level navigation
