---
type: decision
date: 2026-08-05
status: accepted
owner: agent
repos: revdev
related: GAP-309
---

# Decision: `file.write` format posture is check-and-reject

## Context

GAP-309 moves edit-time formatting enforcement out of the Claude-only
`post-edit.js` hook and onto the daemon `file.write` surface so every harness
and human client hits the same chokepoint. Two postures were on the table:

1. **Rewrite** — run the formatter and write the normalized bytes (Claude hook style).
2. **Check-and-reject** — refuse the RPC when content differs from the formatter's output.

## Decision

**Check-and-reject.** Unformatted content returns JSON-RPC `-32007` with
`data.fixCommand` and never touches the destination file.

## Why

- A daemon RPC that silently rewrites bytes makes the caller believe it wrote
  what it sent. That is worse for agents and for Studio than a loud failure.
- The Claude hook remains a **fast-feedback convenience** (rewrite on Edit/Write).
  It can be deleted without weakening the daemon guarantee.
- CI (`pnpm lint` / `cargo fmt --check`) remains the merge guarantee. This
  decision only hardens the edit-time layer on the daemon path.

## Detection

No hardcoded repo path allow-list. Walk up from the target file inside the
registered root to the nearest `biome.json` / `biome.jsonc` or `Cargo.toml`.
Exempt generated segments (`node_modules`, `dist`, `target`, …). Extension-
gated so a biome monorepo does not try to format `.md` / `.rs` by accident.

## Out of scope

- Git commit-time hooks (revkit / Husky) — separate layer; `core.hooksPath` is
  single-valued so they cannot alone cover every fleet repo.
- Auto-commit crash protection — stays opt-in on the Claude side only
  (`CLAUDE_AUTOCOMMIT=1`); never ported to the daemon.
