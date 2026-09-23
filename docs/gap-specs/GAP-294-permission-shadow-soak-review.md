---
type: plan
title: Permission shadow soak review (when to flip REVDEV_PERMISSION_MODE)
status: scheduled
created: 2026-07-21
target-review: 2026-07-28
related:
  - docs/gaps/GAP-294.yml
  - docs/gap-specs/GAP-294-permission-modes-design.md
  - docs/initiatives/revdev-daily-driver.md
  - revdev#303 #304 #306 (merged train)
---

> **HISTORICAL RECORD (relocated 2026-07-23).** Superseded as a free surface — executable work is only gaps/lanes via `docs/TRACKER.md`. Preserved for history.

# Permission shadow soak review

## Decision deferred until review

**Do not** set `REVDEV_PERMISSION_MODE=manual` (or `auto`) for day-to-day work
until this review is green. Default remains **shadow** (would_* events only).

## When to run this review

**Best window: 2026-07-28 (±1 day)** — about **7 calendar days / ~5 full work
sessions** of real daemon use after Phase 0+1 landed on the live unit
(2026-07-21).

**Run earlier only if:**

- You are deliberately dogfooding the approval queue in a throwaway session, or
- Studio approval UI (GAP-294 Phase 2) has already shipped and you want `auto`.

**Run later if:**

- Fewer than ~3 multi-hour agent sessions used the daemon since 2026-07-21, or
- `permission.would_*` volume is too thin to judge false positives.

## Pre-checks (5 minutes)

```bash
systemctl --user is-active revdev-daemon
journalctl --user -u revdev-daemon -n 30 --no-pager | grep -iE 'confinement|permission|ENTERPRISE'
# Expect: confinement active; no need for PERMISSION_MODE yet
```

## Soak evidence (read PGlite events)

From a machine with the daemon data dir (default
`~/.local/share/revealui`):

1. Confirm events exist for real traffic (not only smoke IDs):
   - `permission.would_allow`
   - `permission.would_require_approval`
2. Spot-check that **routine** work is mostly `would_allow`
   (reads, mail/tasks, git status/diff).
3. Spot-check that **critical** paths show `would_require_approval`
   (`git.push`, `agent.spawn`, `git.discardFile`, `project.open`, …).
4. Flag false positives (methods that would block normal daily driver under
   manual) and false negatives (dangerous methods that only `would_allow`).

If you lack a SQL shell into PGlite, use daemon logs / any events.query client
already wired, or a one-off admin RPC once registered.

## Verdict options

| Outcome | Action |
|---------|--------|
| **Stay shadow** | Classifications noisy or traffic thin; leave default; re-review +7d |
| **Try auto (preferred dogfood)** | Critical-only friction; set `REVDEV_PERMISSION_MODE=auto` for 1–2 sessions |
| **Try manual (strict)** | Only if ready to decide approvals via signed `permission.decide` / second agent / CLI |
| **Unblock Phase 2** | File/build Studio approval UI before any permanent manual default |
| **Phase 3** | Owner flip of install default — only after auto/manual dogfood felt right |

## How to flip (experiment only)

```bash
mkdir -p ~/.config/systemd/user/revdev-daemon.service.d
printf '%s\n' '[Service]' 'Environment=REVDEV_PERMISSION_MODE=auto' \
  > ~/.config/systemd/user/revdev-daemon.service.d/permission-mode.conf
systemctl --user daemon-reload && systemctl --user restart revdev-daemon
# Revert experiment:
# rm ~/.config/systemd/user/revdev-daemon.service.d/permission-mode.conf
# systemctl --user daemon-reload && systemctl --user restart revdev-daemon
```

## Out of scope for this review

- Permanent default for all installs (GAP-294 Phase 3, owner-gated)
- Agent-scoped grants (spec §9)
- Local-model classifier tier (GAP-296)
