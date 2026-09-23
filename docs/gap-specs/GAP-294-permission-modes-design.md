# GAP-294 — RevDev Permission Modes: Manual / Auto / Agent

**Status:** §4 + §5 COUNTERSIGNED (owner, in-session directive 2026-07-17, as recommended — including the four flagged §5 judgment calls as written: `git.pull` consequential, `git.deleteBranch` consequential, `agent.input` consequential, `memory.store` routine). Originally PROPOSED by the Fable design pass 2026-07-12 (no safeguard pause). **Build is UNBLOCKED**: Opus to §10's shadow-first rollout, guardrail-2 verdict per PR.
**Gap:** [`docs/gaps/GAP-294.yml`](../gaps/GAP-294.yml) · **Reference UX:** Claude Code permission modes (manual approve / auto classifier + deny-list / delegated) — this is the provider-agnostic RevealUI-native analog (GAP-293 parity; `parallel-native-implementation.md` pair satisfied by being the native side).
**Grounded against:** `revdev test @ 6e4e88c`, audited 2026-07-12; the GAP-326 branch (`b790234`, `fix/gap-326-file-layer-neverbound`) is noted where it matters. Every load-bearing claim carries file:line.

## 1. Scope

The daemon has license-tier gating (`license.ts`) and the signature/identity/confinement guards, but **no user-facing permission-mode concept** — an action is allowed by tier or it is not. Zero approval/policy/consent code exists today (verified: a tree-wide grep for approve/consent/permission-mode/pending-approval over `packages/` + `apps/` returns no source hits; the only adjacent artifact is `blocked_reason` defaulting to `'permission'` at `server.ts:1137`). This spec designs the three modes the owner directed (manual + auto are the priorities; agent explicitly last), the action taxonomy, the pending-approval queue, and the audit trail — additive to every existing gate.

Out of scope: the auto-mode local-model classifier tier (later increment, primitives-first per GAP-296); agent-mode implementation (gates on GAP-288 / the agent.* HOLD; specced here at contract level only).

## 2. Audit findings the design builds on (ground truth)

1. **The dispatch pipeline has the exact seam.** Per-frame gate chain in `server.ts:1847-2056`: frame bound → parse → license guard (`:1932`) → param validation (`:1939`) → handler existence (`:1946`) → signature gate (`:1964`, binds `ctx.agentId`) → required-signature enforcement against `MUTATING_OR_CONTENT_METHODS` (`:1970-1989`, the set at `:153-236`) → identity gate (`:1994-2010`) → shutdown gate (`:2018`) → dispatch. Each stage short-circuits before `await handler()`. The permission gate inserts after the identity gate and before the shutdown gate.
2. **"Blocked awaiting a human" is already modeled.** Migration 0005 added `activity_state/blocked_reason/blocked_since` to `agent_sessions`, written self-scoped-only by `session.update` (`server.ts:1104-1149`; GAP-257's self-scope security requirement is implemented). Extend, don't duplicate.
3. **The audit surface exists.** `events` (`storage/schema.ts:68-77`) is an append-only typed-event table reachable synchronously from any handler (`events.log`, `server.ts:1533`); already used for signature + license telemetry.
4. **The classification discipline exists.** `EXEMPT_METHODS` + `METHOD_MIN_TIER` (`license.ts:63-138`) — explicit tables, no wildcards, fail-closed default (`requiredTier` defaults to `'pro'`, `:155-157`). The method→class map below follows the same discipline.
5. **Config is env→`DaemonConfig`, no settings table** (`config.ts:5-168`; env read in `cli.ts`). A global mode default belongs there; a per-session override belongs on `agent_sessions`, mirroring how 0005 added columns.
6. **Confinement is mode-independent.** The never-bound set + overlap guard (`confinement.ts:265-324`) and its GAP-326 extension to `project.open`/file resolution are hard boundaries. **Permission mode never overrides confinement** — a grant or an approval can never authorize a never-bound path; those guards run regardless (invariant I3, §8).

## 3. The mode model

`permissionMode: 'manual' | 'auto' | 'agent-scoped'` — effective mode = per-session override ?? daemon default.

- **Daemon default:** new `DaemonConfig.permissionMode` + `REVDEV_PERMISSION_MODE` env (read in `cli.ts` like `REVDEV_SPAWN_CONFINEMENT`).
- **Per-session override:** new nullable `permission_mode` column on `agent_sessions` (migration `0007-permission-mode`, same shape as 0005).
- **A session can NEVER set its own mode.** Mode-setting is operator-only (§6) — otherwise the gate is self-defeating (an agent in manual would flip itself to auto). This is the same one-door principle as GAP-313: exactly one door, human-held, every use recorded.

## 4. Mode semantics (owner countersign surface) — COUNTERSIGNED 2026-07-18

> **RULED 2026-07-18 (owner, in-session): §4 + §5 ratified AS WRITTEN**, including
> `agent.stop` = routine (the stopping-is-safe rationale was explicitly flagged to the
> owner and confirmed, not blanket-ratified). Build unblocked per §7 routing.

Three action classes (§5) × three modes:

| | `routine` | `consequential` | `critical` |
|---|---|---|---|
| **manual** | allow | **approval required** | **approval required** |
| **auto** | allow | deterministic policy (§7): deny-list → deny; within granted root → allow + audit | **approval required (policy floor — never silently auto-approved)** |
| **agent-scoped** | allow | allowed iff covered by an operator-issued grant (§9), else escalate as manual | grant may cover it ONLY if the grant explicitly names the method; else approval required |

The auto-mode **policy floor** implements the gap's acceptance line "no security-sensitive action silently auto-approves below its policy floor": `critical` is the floor, and nothing in the policy engine (including the future classifier tier, which may only tighten, never loosen — §7) can lower it.

## 5. Method → action-class table (owner countersign surface)

Discipline: explicit map `METHOD_ACTION_CLASS` in a new `packages/daemon/src/permission.ts`, no wildcards; **an unmapped method fails closed to `critical`** (same posture as `requiredTier`'s fail-closed default and the GAP-267 "new method with no entry fails closed" rule). A CI enumeration test asserts every name in `RPC_METHODS` (`packages/protocol/src/methods.ts:8-80`) plus the dispatch-only extras (`identity.rotate`) resolves to a class.

**`routine`** — reads, diagnostics, and daemon-internal coordination state (mutations that touch only the coordination DB, never the working tree, a process, or an authorization boundary):
`ping` · `session.register` · `session.attach` · `session.list` · `session.update` (already hard-scoped to self, `server.ts:1104`) · `mail.send` · `mail.broadcast` · `mail.inbox` · `mail.markRead` · `files.reserve/check/release/list` (advisory reservations) · `tasks.create/claim/complete/release/list` · `events.log` · `events.query` · `memory.store` · `memory.query` · `harness.health` · `inference.status/chat/generate` · `file.read` · `file.stat` · `git.status/diffFile/diffContent/readBlobAtHead/readBlobAtIndex/listBranches/log` · `worktree.list` · `merge.status/list` · `agent.output` · `agent.resize` · `agent.stop` (stopping is the safe direction) · `permission.pending` (new, §6).
Rationale for coordination mutations being routine: a permission prompt on every `mail.send` makes manual mode unusable for the hook flow, and these methods cannot reach the filesystem, a process, or a trust boundary. Reads within a granted root are routine because **the root grant was the approval** (`project.open` is `critical`).

**`consequential`** — mutations to the operator's working tree/repos, confined within an already-granted root:
`file.write` · `file.delete` · `git.stageFile` · `git.unstageFile` · `git.createBranch` · `git.switchBranch` · `git.deleteBranch` (ref recoverable via reflog) · `git.commit` · `git.pull` (inward tree mutation) · `worktree.create` · `agent.input` (drives a live, already-approved PTY) · `merge.request` · `merge.update`.

**`critical`** — boundary-crossing, irreversible, authorization-mutating, process-spawning, or outward-network:
`agent.spawn` (process creation; confinement still applies) · `git.push` (outward publication) · `git.discardFile` (irreversibly destroys uncommitted work) · `project.open` · `project.grant` · `project.revoke` (authorization boundary) · `worktree.remove` (deletes a tree) · `harness.prune` (destructive, cross-agent) · `identity.rotate` · `session.end` (evicts roots + kills PTYs, `server.ts:1052-1087`) · `inference.pull/start/stop` (model lifecycle: disk + long-lived process) · `permission.decide` + `permission.setMode` (new, §6 — the gate's own controls are maximally protected).

Judgment calls explicitly flagged for the owner: `git.pull` consequential-not-critical (it imports remote code — argument exists for critical); `git.deleteBranch` consequential (reflog-recoverable) while `git.discardFile` is critical (nothing recovers uncommitted work); `agent.input` consequential (the spawn was the approved act; input is its purpose); `memory.store` routine (coordination-DB only). Move any of these rows and the table stays coherent.

## 6. Manual mode: the pending-approval queue

**Reject-with-receipt, not held calls.** A gated call is NOT parked on the socket (human latency is minutes-to-hours; the frame loop `server.ts:1847+` is not built for parked requests and a held mutating call would pin its signature envelope past the 60s window, `SIG_TS_WINDOW_SECS server.ts:636`). Instead:

1. The permission gate refuses dispatch with a **new JSON-RPC error `-32004 approval-required`** (sibling of -32001 license / -32002 identity / -32003 signature), body `{approvalId, method, expiresAt}`.
2. A row lands in a new `pending_approvals` table (migration 0007): `id, agent_id, method, params_hash, summary, requested_at, expires_at, status('pending'|'approved'|'denied'|'expired'|'consumed'), decided_by, decided_at`. `params_hash` is the same hash the signature envelope uses (`hashParams`, bridge `client.ts:26`) so the approval binds to the exact bytes. `summary` is a bounded human-readable extract per method (path for `file.write`, remote+branch for `git.push`, argv head for `agent.spawn`) — **the operator must see what they approve**; the hash binds the rest (no bait-and-switch: the approved call and the executed call are byte-identical or the approval does not match).
3. The requesting session is marked `activity_state='blocked', blocked_reason='permission'` via the existing self-scoped path (extends 0005; cleared on decision or expiry).
4. **Decision surface:** two new methods. `permission.pending` (read: list pending rows). `permission.decide {approvalId, verdict}` (mutating + signature-required + **operator-only**). Operator identity anchors on the existing trusted-client mechanism (`REVDEV_DAEMON_TRUSTED_CLIENT_FP`, read in `cli.ts`) — the decider's verified key fingerprint must match the trusted client, AND `decider.agentId !== requester.agentId` (**self-approval is structurally impossible**, the GAP-257 self-scope lesson applied to the decision path). Studio drives this through its signed Rust client (`harness.rs`); headless fallback is a `revdev approvals` CLI over the bridge `DaemonClient` (which already signs envelopes, `client.ts:26,38`).
5. **Consumption:** after approval, the agent re-sends the same call (freshly signed). The gate matches `(agent_id, method, params_hash)` against an `approved` unexpired row and consumes it **in the same transaction** as the check (single-use; a second identical call requires a new approval). Approvals expire unconsumed after a short TTL; pending requests expire after a longer one (named constants, e.g. `APPROVAL_CONSUME_TTL` / `PENDING_TTL`).
6. **Audit:** every transition writes a typed `events` row — `permission.requested` / `.approved` / `.denied` / `.expired` / `.consumed` — carrying method, `params_hash`, requester, decider. This satisfies the gap's "approvals are audited (events.log)" acceptance with zero new audit machinery.
7. **Flood guard:** pending rows are capped per agent (named constant, e.g. 10); beyond the cap the gate returns -32004 without queueing — a buggy or adversarial agent cannot grow the queue unboundedly or spam the operator surface.

## 7. Auto mode: deterministic policy engine

Ordered, first-match-wins, in `permission.ts` (fully local per the GAP-296 boundary — no model required):

1. Class `critical` → escalate (identical path to §6 — the manual queue IS the escalation mechanism; one primitive, two modes).
2. Operator deny-list (config: method names and/or root-relative path prefixes; `Set` membership + prefix checks, zero authored regex) → deny outright with -32004-family error + `permission.denied` audit row. Deny is absorbing.
3. Class `consequential` and the target resolves within the caller's granted root (the existing `requireRoot`/`resolveInRoot` machinery, `filegit.ts:215-280`, already enforces this before the handler runs) → allow + `permission.auto_allowed` audit row.
4. Anything else (including every unmapped method via the fail-closed default) → escalate.

The future local-model classifier tier slots between 3 and 4 for gray-zone calls with one hard rule: **its verdict may only tighten (escalate), never allow something the deterministic layers would not** — so a wrong classifier degrades to friction, never to a hole. Boundary tracked in GAP-296.

## 8. Invariants (test-pinned)

- **I1 — additive only.** The permission gate never relaxes license (-32001), identity (-32002), signature (-32003), or param-validation outcomes; it runs after them and can only refuse more.
- **I2 — fail closed.** Unmapped method → `critical`. Unknown mode value → `manual`. Gate-internal error → refuse (never dispatch-on-exception).
- **I3 — confinement is senior.** No mode, approval, or agent-scope grant authorizes a never-bound path or skips `assertGrantedRootBindable`/the GAP-326 file-layer guards. The permission layer sits ABOVE confinement, never beside it.
- **I4 — one door.** Mode changes and approval decisions are operator-only, self-decision structurally rejected, every use audited (GAP-313 topology).
- **I5 — byte-bound approvals.** An approval matches exactly one `(agent, method, paramsHash)` and is single-use.

## 9. Agent-scoped mode (contract only; implementation gates on GAP-288)

An operator-issued, signed **scope grant**: `{granteeAgentId, classes?: ['consequential'], methods?: [...], rootScope: <granted-root>, expiresAt, maxUses?}`, stored in PGlite, issued/revoked via operator-only methods (same trust anchor as §6). The permission gate consults grants between steps 2 and 3 of §7. A grant may cover `critical` methods only by naming them explicitly (never by class). Composes with, never replaces, confinement and the B3 tier guard. Explicitly last per owner priority; this section exists so manual/auto are built with the grant hook in place rather than retrofitted.

## 10. Rollout (shadow-first, fleet pattern)

- **Phase 0 — SHADOW.** Gate ships classifying every call and writing `permission.would_*` audit rows, blocking nothing (`REVDEV_PERMISSION_MODE` unset ⇒ shadow). Confirms the class table against real traffic before any friction exists — the GAP-310/review-eval pattern.
- **Phase 1 — manual mode usable headless.** `pending_approvals` + `-32004` + `permission.pending/decide` + `revdev approvals` CLI. Manual is only selectable once a decision surface exists (a manual mode with no approval surface is a lockout, not a safe default).
- **Phase 2 — Studio approval UI** (queue view + approve/deny in `apps/studio`, driven by `permission.pending` + `session.list` blocked state) + operator-set per-session mode (`permission.setMode`).
- **Phase 3 — enforce defaults (OWNER FLIP).** Owner picks the shipping default (`manual` for new installs per the gap's safe-default intent; existing fleet daemon pinned to `auto` or per-session) after the shadow log is clean.

Each phase is one PR to `revdev:test`; daemon dispatch + authorization surface ⇒ **guardrail-2 recorded non-author verdict on every PR**, Fable review per model-allocation rule 2, owner merges. Red-first tests per phase (approval consumed exactly once; self-decide rejected; paramsHash mismatch does not consume; shadow blocks nothing; unmapped method escalates; deny-list absorbs; critical floor holds in auto).

## 11. Acceptance mapping

| GAP-294 acceptance | Where |
|---|---|
| Owner can switch modes from Studio/config; mode visibly changes behavior | §3 (config+column), §6.4/§10 Phase 2 (Studio), §4 (matrix) |
| Manual blocks consequential actions until approved; approvals audited in events.log | §6 (queue, -32004, single-use), §6.6 (typed events) |
| Auto approves routine via deterministic policy, documented escalation, no security-sensitive silent auto-approve below the floor | §7 (ordered policy), §4 (critical floor) |
| Agent mode exists as a specced scope-grant model, implementation may trail | §9 |
| Spec maps every daemon RPC method to an action class | §5 (+ fail-closed default + CI enumeration test) |
