---
type: master-plan
repo: revdev
last-updated: 2026-07-23
owner: RevealUI Studio
staleness-status: FRESH
---

# RevDev — Master Plan

**Last Updated:** 2026-07-23
**Status:** Pre-1.0 — Studio + Console + harness daemon all buildable; no public releases yet
**Owner:** RevealUI Studio (`founder@revealui.com`)
**Repo:** [RevealUIStudio/revdev](https://github.com/RevealUIStudio/revdev)

> **The plan lives in one place: [`docs/PLAN.md`](./PLAN.md).** This file is the stable entry point; it carries no plan content of its own. The former `PRODUCTION_LAUNCH_PLAN.md` was absorbed into `PLAN.md` on 2026-06-11 with every status re-verified.
>
> Fleet-level cross-cutting plans live in the RevealUI Studio internal coordination hub (private); this repo's plan is RevDev-scoped only.

---

## What RevDev is

**One product, two interfaces, one daemon:**

- **Studio** — Tauri 2 + React 19 desktop AI editor + agent coordination dashboard
- **Console** — Go + Bubble Tea SSH TUI ops cockpit (agent health, deploys, billing, alerts)
- **Harness daemon** (Node.js) — coordinates agents, manages PTY sessions, routes tools to the RevealUI API. Studio and Console are different UIs for the same daemon.

## Where things stand

Current verified state, workstreams (launch readiness, identity rollout, cross-machine coordination, Studio dogfood, Console, releases), the owner action queue, and exit criteria: **[`PLAN.md`](./PLAN.md)**.

## See also

- [`docs/PLAN.md`](./PLAN.md) — **the plan** (single source)
- [`docs/MASTER_SPEC.md`](./MASTER_SPEC.md) → [`docs/SPEC.md`](./SPEC.md) — the spec
- [`docs/INDEX.md`](./INDEX.md) — documentation index
- [`README.md`](../README.md) — overview + architecture · [`CLAUDE.md`](../CLAUDE.md) — agent context
