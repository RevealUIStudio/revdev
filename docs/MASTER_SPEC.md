---
type: master-spec
repo: revdev
last-updated: 2026-07-23
owner: RevealUI Studio
staleness-status: FRESH
---

# RevDev — Master Spec

**Last Updated:** 2026-07-23
**Status:** Pre-1.0 — daemon production-grade for internal use; Studio + Console builds clean; no public releases
**Repo:** [RevealUIStudio/revdev](https://github.com/RevealUIStudio/revdev)

> **The spec lives in one place: [`docs/SPEC.md`](./SPEC.md)** — surface area, architecture, JSON-RPC contract, license model, identity. This file is the stable entry point; it carries no spec content of its own. (Consolidated 2026-06-11; the licensing model previously specced in the internal coordination hub was absorbed into `SPEC.md` §License model.)

---

## Mission

Native developer tools for RevealUI. **One product, two interfaces, one daemon.** Studio (Tauri 2) and Console (Go SSH TUI) are different UIs over the same JSON-RPC harness daemon. The daemon coordinates AI agents, manages PTY sessions, and routes tools to the RevealUI API.

## See also

- [`docs/SPEC.md`](./SPEC.md) — **the spec** (single source)
- [`docs/MASTER_PLAN.md`](./MASTER_PLAN.md) → [`docs/PLAN.md`](./PLAN.md) — the plan
- [`docs/API_REFERENCE.md`](./API_REFERENCE.md) — JSON-RPC API reference
- [`docs/INDEX.md`](./INDEX.md) — documentation index
- [`CLAUDE.md`](../CLAUDE.md) — agent context · [`README.md`](../README.md) — overview
