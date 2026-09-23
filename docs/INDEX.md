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

- [`gap-specs/GAP-294-permission-modes-design.md`](./gap-specs/GAP-294-permission-modes-design.md) — GAP-294 permission modes (manual / auto / agent). §4 and §5 countersigned 2026-07-18. Install default stays `shadow` until the owner flips it.
- [`gap-specs/GAP-294-permission-shadow-soak-review.md`](./gap-specs/GAP-294-permission-shadow-soak-review.md) — historical soak review for that flip.
- [`gap-specs/GAP-294-permission-modes-STOP.md`](./gap-specs/GAP-294-permission-modes-STOP.md) — note that the design is vendored here.

## Fleet coordination

Part of [RevealFleet](https://github.com/RevealUIStudio). Fleet-level planning, lanes, the gap tracker, and the live workboard live in the RevealUI Studio internal coordination hub (private repo); this repo's docs are RevDev-scoped only.
