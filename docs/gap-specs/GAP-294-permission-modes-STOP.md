---
type: stop
date: 2026-09-23
status: blocked
gap: GAP-294
owner: RevealUI Studio
repos: revdev
related: permission modes (manual, auto)
---

# GAP-294 — STOP: countersigned permission-modes spec is not in this repo

No permission-mode behavior was changed. The daemon default stays
`shadow` (`REVDEV_PERMISSION_MODE` unset or unknown → `shadow` in
`resolvePermissionMode`). This document does not define manual or auto
policy.

## Request

Implement the remaining manual and auto permission modes from the
owner-countersigned GAP-294 spec. Do not flip the default mode.

## What is missing

The countersigned design text is not in this git tree. The only in-repo
reference is a pointer, not the document:

- `packages/daemon/src/permission.ts` cites
  `.jv` `docs/gap-specs/GAP-294-permission-modes-design.md` §5–§10.
- The same file cites “GAP-294 design §5 (owner countersigned 2026-07-18).”
  The countersignature and the §5 text are not stored here.

Checked and not found:

- No `docs/gap-specs/GAP-294-permission-modes-design.md` (this directory
  did not exist before this STOP note).
- No copy of that filename in the work tree or in git history.
- No `.gitmodules` entry and no `.jv` checkout on this machine
  (`~/revealfleet/.jv` is absent).
- Public code search under `RevealUIStudio` did not return the design
  file. `docs/INDEX.md` says fleet planning and the gap tracker live in
  the private coordination hub, which is not vendored into revdev.

Without that file, “remaining” manual and auto behavior cannot be
identified. Filling the gap from code comments would invent policy.

## Spec sections the code names, whose source text is absent

These citations are enough to know which parts of the design must be
present before any further manual/auto work. They are not a substitute
for the design.

| Cited section | What the implementation comments claim it covers | Why work stops |
|---|---|---|
| §3 | Effective mode: per-session override, else daemon default | Cannot confirm the override rules or which modes a session may select |
| §4 | Live policy for manual and auto | Cannot confirm allow / require-approval / deny for each action class |
| §5 | Method → action class map, countersigned 2026-07-18 | The in-repo map cannot be diffed against the signed taxonomy |
| §6 | Approval-required error (`-32004`) and pending-queue data | Cannot confirm TTLs, caps, receipt shape, or consume rules |
| §9 | Agent-scoped grants | Same missing document; not implemented further here |
| §10 | Phase plan (shadow, then manual/auto, then UI, then default flip) | Cannot tell which manual/auto clauses are still open |

Also absent, so not assumed:

- The countersignature block (who signed, date, any conditions).
- Any later amendment that narrows or extends manual or auto.
- A deny-list, root-probe, notification, or Studio rule that is only
  written in the design and not already committed under a quoted clause.

## Already in the tree (code facts, not a spec match)

These exist so a follow-up can diff them against the vendored design.
They are not evidence that the countersigned spec is fully implemented.

- `REVDEV_PERMISSION_MODE`: `shadow` (default), `manual`, `auto`,
  `agent-scoped`.
- Shadow `permission.would_*` events.
- `pending_approvals` (migration 0007), `permission.pending`, signed
  `permission.decide`, reject-with-receipt `-32004`.
- `permission.setMode` and the Studio approval queue.
- Agent-scope grants (migration 0009): `permission.grant`,
  `permission.listGrants`, `permission.revokeGrant`.
- `skills.invoke` inner-tool classification
  (`skills.tool.Read` / `Grep` / `Glob` / `Bash`).

Merged history that landed those pieces: #303, #306, #307, #352, #354,
#403. Default-mode flip was left to the owner and is still not done.

## Unblock

1. Add the countersigned file to this repo (path the code already
   cites, or another path plus an updated citation), including the
   2026-07-18 countersignature and any later amendments.
2. Diff that text against `packages/daemon/src/permission.ts` and the
   dispatch gate in `packages/daemon/src/server.ts`.
3. Implement only the manual and auto clauses that the diff shows are
   still open. Leave the default mode at `shadow` until the owner flips
   it.
