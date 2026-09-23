---
type: repo-doc-index
repo: revdev
updated: 2026-09-23
---

# RevDev — Documentation Index

Agent-first SDLC toolkit: Studio (Tauri 2 desktop) + Console (Go SSH TUI) + harness daemon (JSON-RPC over Unix socket).

## This repo's masters

Exactly one plan and one spec, each behind a stable entry point:

- [`MASTER_PLAN.md`](./MASTER_PLAN.md) → [`PLAN.md`](./PLAN.md) — **the plan**: verified state, workstreams, owner queue, exit criteria
- [`MASTER_SPEC.md`](./MASTER_SPEC.md) → [`SPEC.md`](./SPEC.md) — **the spec**: architecture, JSON-RPC contract, license model, identity

(`PRODUCTION_LAUNCH_PLAN.md` was absorbed into `PLAN.md` on 2026-06-11 and removed.)

## Reference docs

- [`API_REFERENCE.md`](./API_REFERENCE.md) — JSON-RPC API surface
- [`GETTING_STARTED.md`](./GETTING_STARTED.md) — quick start
- [`KEY_GENERATION.md`](./KEY_GENERATION.md) — signing-key runbook (Tauri updater + license keypair)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — common issues

## Gap notes

- [`gap-specs/GAP-294-permission-modes-STOP.md`](./gap-specs/GAP-294-permission-modes-STOP.md) — GAP-294 manual/auto work is blocked: the countersigned design is not in this repo. Default permission mode was not changed.

## Fleet coordination

Part of [RevealFleet](https://github.com/RevealUIStudio). Fleet-level planning, lanes, the gap tracker, and the live workboard live in the RevealUI Studio internal coordination hub (private repo); this repo's docs are RevDev-scoped only.
