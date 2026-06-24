---
type: audit
repo: revdev
date: 2026-06-23
method: 14 finder agents + per-surface adversarial verification + architect synthesis (29 agents total)
findings: 182 confirmed (7 critical, 44 high, 71 medium, 60 low; 83 UX, 99 durability)
status: remediation NOT started
---

# RevDev UX & Durability Audit — 2026-06-23

A code-grounded audit of every RevDev surface (Studio React + Tauri Rust backend, Console Go TUI, harness daemon, protocol/bridge, and user docs). Each finding was located by a finder agent and independently re-read by an adversarial verifier; only confirmed findings appear here. All `file:line` references are repo-relative. The narrative below (executive summary through risks) is the architect synthesis; the per-theme execution breakdown and the full enumerated appendix follow.

## Executive summary

RevDev is not ready to put in front of a paying customer, and the gap is not cosmetic. The single most damaging class of defect is **lies told with a green checkmark**: the deploy wizard walks fully green in browser mode while fabricating secrets and "live" deployments; the docs instruct customers to set a license-key format the daemon hard-rejects, so a paying user following Getting Started verbatim silently lands on FREE tier with no diagnosable cause. Layered on top are **destructive one-click actions with no confirmation** (vault secret delete, git discard-all, daemon stop, snap/model delete, SSH bookmark delete) and a **pervasive swallow-the-error culture** across both the React hooks and the Go console, where failures vanish and the operator is left operating broken surfaces with no signal. There are also two **hard crashers** shipping today — a guaranteed React TDZ `ReferenceError` on the Tiles surface every render, and a Rust mutex held across `child.wait()` that deadlocks the entire agent subsystem the moment one agent is spawned. The dominant themes are (1) mock/degraded modes indistinguishable from real, (2) destructive actions without confirmation, (3) silent failure / fail-open everywhere, and (4) stale-and-wrong user docs. **Fix the documentation-vs-license-rejection contradiction first** (4 critical/high doc findings) — it is the cheapest fix with the highest blast radius: it converts every paying first-run customer from "silently broken on FREE" to "working Pro," and it requires zero code change.

## Top defects by theme

### Theme 1 — Docs that actively break the paying customer
The license-activation documentation describes a key format the daemon explicitly rejects, and omits the one env var verification actually requires.
- `critical · docs/GETTING_STARTED.md:92-98 — RVUI.v2. license format documented but hard-rejected by daemon (paying customer silently stays FREE)`
- `critical · docs/TROUBLESHOOTING.md:107-112 — troubleshooting tells user to verify the rejected RVUI.v2. format (user discards a valid eyJ key)`
- `high · docs/TROUBLESHOOTING.md:101-103 — "v1 license keys" section quotes a stderr string the daemon never emits + omits that RVUI.v2.* is also rejected (no search hit on real error)`
- `high · docs/API_REFERENCE.md:78-84 — session.attach marked Free but excluded from EXEMPT_METHODS, returns -32001 on Free`
- `high · docs/GETTING_STARTED.md:93-111 — REVDEV_LICENSE_PUBLIC_KEY never documented; self-host activation cannot succeed without it`
- `medium · README.md:40-47 — repo layout omits packages/bridge that Getting Started tells users to run; no bridge build step`
- `medium · docs/TROUBLESHOOTING.md:126-137 — DB-reset moves entire data dir (socket/pid/sidecars), wider blast radius than the warning states`
- `low · docs/GETTING_STARTED.md:108-111 — grep verification matches the FREE-mode line too; doesn't confirm Pro`

**Fix strategy:** Treat the license format as a single source of truth (`eyJ`-prefixed EdDSA JWT) and do a coordinated doc sweep that purges every `RVUI.v2.`/`RVUI-` reference, quotes the *actual* emitted stderr strings, adds `REVDEV_LICENSE_PUBLIC_KEY` to the env table and activation steps, and reconciles `session.attach`'s tier (the cleaner fix is adding it to `EXEMPT_METHODS` in `license.ts:63-69` so it matches the rest of `session.*`, rather than editing the doc). This is mechanical and zero-risk, but it must be done as one pass against the code so docs and code never drift again. Add a CI doc-lint that greps docs for `RVUI.v2.`/`RVUI-` and fails — the durable guard against re-drift.

### Theme 2 — Mock/degraded modes indistinguishable from production
Browser/mock fallbacks render as real state with no banner, the worst case being a fabricated successful deployment.
- `critical · apps/studio/src/lib/deploy.ts:10-145 — browser mode fakes every deploy step green ("instance is live") with placeholder secrets`
- `high · apps/studio/src/lib/invoke.ts:479-482 — non-Tauri invoke() returns MOCK_DATA (wsl running, tier 'pro') with no indicator`
- `high · apps/studio/src/lib/config.ts:16-31 — browser config served as real, choices lost on reload, no banner` (verify-note: severity medium)
- `medium · apps/console/tui/model.go:127-132,199-206 — pricing fallback tiers shown as real on fetch failure; checkout uses stale IDs`
- `low · apps/studio/src/components/agent/AgentTerminalPane.tsx:32-39 — browser-mode / daemon-down both render as the same empty terminal`

**Fix strategy:** Introduce one global "degraded mode" signal set wherever a fallback fires (`invoke()` MOCK_DATA path, `deploy.ts`/`config.ts` `!isTauri()` short-circuits, console pricing-fetch failure). Render a single persistent, prominent banner in the app shell ("Demo data — not connected to a real system" / "Offline pricing — may be out of date") driven off that flag, and never emit realistic-looking secret values from mocks (use obviously-fake `MOCK_*` sentinels). One banner component + one flag closes the whole class; do not patch each step individually.

### Theme 3 — Destructive actions with no confirmation
Single clicks (often hover-revealed) irreversibly destroy secrets, working-tree edits, daemon state, and multi-GB installs.
- `critical · apps/studio/src/components/vault/SecretList.tsx:34-53 — hover trash deletes a secret with no confirm, no undo`
- `critical · apps/studio/src/components/agent/AgentPanel.tsx:411-420 — Discard All / per-file discard destroys uncommitted work, no confirm` (also GitPanel.tsx:510-520)
- `high · apps/studio/src/components/infrastructure/DaemonPanel.tsx:111-128 — Stop/Restart tear down the daemon + all agent sessions, no confirm`
- `high · apps/studio/src/components/terminal/SshBookmarkSidebar.tsx:53-56 — bookmark delete unconfirmed (also ConnectForm.tsx:59-62)`
- `medium · apps/studio/src/components/inference/InferencePanel.tsx:171-177 — snap Remove / model Delete destroy multi-GB installs, no confirm`
- `medium · apps/studio/src/components/agent/SpawnerPanel.tsx:89-107 — Stop/Remove agent unconfirmed and void-swallowed`
- `medium · apps/studio/src/components/deploy/StepDatabase.tsx:50-57 — Connect & Migrate runs irreversible migrate+seed on '.' with no confirm`
- `medium · apps/studio/src/components/setup/SetupWizard.tsx:44-46 + App.tsx:142-147 — Skip / backdrop dismiss permanently marks setup complete`

**Fix strategy:** Build one reusable destructive-confirm primitive (a `ConfirmDialog` taking title/body/affected-items/confirm-label, optional type-to-confirm for the irreversible ones — vault secret, git discard, DB seed) and route every destructive handler through it. Separate "dismiss modal" from "commit a state change" everywhere (SetupWizard onClose must not equal setupComplete). This is one component plus mechanical wiring; the design decision is only *which* actions need type-to-confirm vs a simple yes/no (recommend type-to-confirm for vault-delete, git-discard-all, and DB-seed-against-existing-data).

### Theme 4 — Silent async failures & swallowed errors (React + libs)
Rejections are dropped via `void`/empty-catch, so operators act on a broken surface with no feedback.
- `high · apps/studio/src/lib/auth-api.ts:68-77 — no res.ok check; rate-limit/expired/500 all show "Unable to reach the RevealUI API" or "Invalid verification code"`
- `high · apps/studio/src/hooks/use-vault.ts:105-124 — createSecret/deleteSecret no try/catch (perceived data loss)`
- `high · apps/studio/src/hooks/use-ssh.ts:124-136 + use-local-shell.ts:107-117 — send/resize on a dead session reject uncaught; terminal silently eats input`
- `high · apps/studio/src/components/agent/AgentPanel.tsx:392-396 — git stage/unstage/discard chains drop errors; failures vanish`
- `high · apps/studio/src/components/intent/IntentScreen.tsx:59-64 — config write failure dead-ends onboarding with zero feedback`
- `medium · use-harness.ts:179 / use-harness.ts:209-259 / use-spawner.ts:47-51 / use-apps.ts:7-22 — floating promises, mutation helpers without try/catch, post-unmount work` (use-apps verify-note: medium, RPC-leak not crash)
- `medium · apps/studio/src/hooks/use-auth.ts:177-204 + 151-157 — token refresh failure swallowed; offline keeps possibly-expired token as authenticated`
- plus the console-side twins in Theme 6.

**Fix strategy:** Establish a hook error contract — every mutation wraps the invoke in try/catch and writes the existing `error` state (the read paths already do this; the mutations are the inconsistent ones). Add a single `httpRequest` helper that checks `res.ok`, distinguishes 4xx (actionable) from 5xx (server) from `TypeError` (network), and guards `res.json()`; route `auth-api`/`health-api`/`billing-api`/`httpRpc` through it. For PTY/SSH send/resize, catch and route to `onDisconnect`/`error`. Replace `void fn()` call-site patterns with `.catch(handler)`. A repo-wide lint banning bare `catch {}` and `void`-ed promises in `hooks/` and `lib/` prevents regression.

### Theme 5 — Hard crashers (TDZ, deadlock, panics, unhandled rejection)
Defects that crash a surface or the whole process.
- `critical · apps/studio/src/hooks/use-tiles.ts:193-198 — allTiles read before const declaration → ReferenceError every render; Tiles surface unusable`
- `critical · apps/studio/src-tauri/src/spawner.rs:204-227 — sessions Mutex held across child.wait(); spawning one agent deadlocks list/stop/spawn (true deadlock, Stop can't acquire lock)`
- `high · packages/daemon/src/validation/schemas.ts:259-264 — events.log payload refine JSON.stringify throws on BigInt/circular; escapes safeParse → unhandled rejection in socket handler (remote DoS, pre-auth)`
- `high · apps/console/proxy/proxy.go:188-241 — bridge double-closes done channel → panic`
- `high · apps/console/proxy/proxy.go:129,158,177 — sessionID[:8] panics on short/empty IDs (also :98-110 treats error responses as success)`
- `high · apps/studio/src-tauri/src/tray.rs:13 — default_window_icon().unwrap() panics app at startup if no icon`

**Fix strategy:** These are independent point-fixes, but they share a posture: **no untrusted/external value reaches an unguarded slice, cast, unwrap, or stringify.** Move the `allTiles` const above its first use; restructure the Rust wait thread to take the child out under a brief lock and `wait()` unlocked (or per-session `Arc<Mutex<Child>>`); wrap the Zod refine's `JSON.stringify` in try/catch (predicate must never throw) and add a try/catch around `validateParams` in the socket handler; use `sync.Once`/`context.CancelFunc` for the `done` channel and a `short(id)` helper for all three slices; match the `Option` on the tray icon instead of `unwrap()`. Each is small; collectively they remove every confirmed crash path. The events.log DoS is the one to prioritize within this theme — it is remotely reachable before the identity gate.

### Theme 6 — Daemon-down / connection recovery & lifecycle
Connection loss, hangs, and lifecycle controls that can't recover.
- `high · apps/studio/src/lib/invoke.ts:442-446 — httpRpc fetch has no timeout; remote-daemon calls hang the UI forever`
- `high · apps/console/proxy/proxy.go:50-55 — "Falling back to payment TUI" is a lie; session dead-ends`
- `high · apps/console/proxy/proxy.go:179 — WebSocket dial: no HandshakeTimeout, no Authorization header`
- `high · apps/studio/src-tauri/src/ssh.rs:346-395 — channel mutex held across wait().await; SSH terminal hangs at every idle prompt`
- `high · packages/daemon/src/server.ts:491,651,… — Neon dual-writes awaited in handler hot path; a slow Neon stalls every coordination RPC and blocks shutdown drain`
- `high · apps/studio/src-tauri/src/platform/windows.rs:101-143 — sync reset --hard against retired E:\repos; origin/- on branch-detect failure`
- `high · apps/studio/src-tauri/src/spawner.rs:54-61 — spawned agents have no kill-on-drop / app-exit kill; orphaned ollama on a 7.3GB box`
- `medium · daemon_ctl.rs:166-183 / 97-102 / 110-145 — no SIGKILL escalation, stale-PID blocks start, child.id() vs PID-file mismatch`
- `medium · billing-api.ts:30-50 / invoke.ts:416-425 — license fetch + pairing have no timeout`

**Fix strategy:** Two sub-strategies. (a) **Bound every wait:** add `AbortSignal.timeout()` to every `fetch` that lacks one (mirror the existing 5s in `health-api`/`a2a-api`), set `HandshakeTimeout` + pass the bearer header on the gorilla dialer, and make Neon dual-writes fire-and-forget with `.catch()` (or wrap in a timeout) so PGlite-committed RPCs never block on the mirror or the shutdown drain. (b) **Make lifecycle authoritative and recoverable:** never hold a mutex across a blocking `wait()` (Rust SSH + spawner), add SIGKILL escalation + reachability-gated start (not bare PID liveness), return the PID-file value as authoritative, add `Drop`/exit-hook child kills, and replace `reset --hard` sync with `pull --ff-only` (the E:\repos path is retired — guard it). Fix the console's false "falling back" message by actually invoking the payment TUI or replacing it with an honest retry/quit prompt.

### Theme 7 — Deploy wizard durability (state loss, no gating, false sign-off)
Beyond the critical mock issue, the wizard loses irreversible secrets and signs off green on untested paths.
- `high · apps/studio/src/components/deploy/DeployWizard.tsx:44-57 — all WizardData (generated REVEALUI_KEK/RSA keys, tokens) volatile; lost on reload, no draft persistence`
- `high · apps/studio/src/components/deploy/DeployWizard.tsx:108-147 — sidebar lets user jump to Deploy bypassing prerequisites`
- `high · apps/studio/src/hooks/use-deploy-wizard.ts:33-37 — completeStep return discarded; checkmarks never update in-session`
- `high · apps/studio/src/components/deploy/StepVerify.tsx:62-72,101-112 — "All checks passed/live" while email never tested and admin push silently skipped if no apiProjectId`
- `high · apps/studio/src/components/deploy/StepDeploy.tsx:21-24,… — up-to-5-min deploy with no cancel/progress`
- `medium · StepStripe.tsx:55-69 / StepVercel.tsx:137-154 / StepDomain.tsx:32-38 — swallowed parse → empty price IDs shown "connected"; checklist always all-green; no domain validation`
- `medium · StepSecrets.tsx:63-80 — one-time KEK/RSA keys never revealable/copyable, no regenerate`
- `medium · DeployWizard.tsx:47-53 — config load failure hangs on "Loading…" forever`
- plus medium/low: input-lock dead-ends, "Retry Failed" redeploys all, identical health ternary, zero-state, status color-only.

**Fix strategy:** Persist `WizardData` (at minimum the irreversible generated secrets/keys) to secure config storage as steps complete and rehydrate on mount — this closes the highest-durability item and unblocks the resume path. Gate nav on prerequisite completion (`goTo` refuses forward jumps past first incomplete step). Make verification honest: actually test email send (or label "Not verified") and fail loudly when `apiProjectId` is missing. Add an `AbortController` + progress/cancel to the deploy poll. Push the `completeStep` return back into `useConfig` so checkmarks update. The remaining medium/lows (validation, edit-to-unlock, targeted retry, zero-states) are mechanical follow-ups once the state model is fixed.

### Theme 8 — Accessibility: color-only status & unlabeled controls
At-a-glance health is invisible to assistive tech and ambiguous to colorblind users.
- `medium · apps/studio/src/components/ui/StatusDot.tsx:39-50 — dot is aria-hidden, color is the only done/pending signal`
- `medium · apps/studio/src/components/dashboard/DeployDashboard.tsx:124-147 — service dots color-only; two StepDeploy states share orange`
- `medium · apps/studio/src/components/dashboard/HealthCard.tsx:74-84 — status dots aria-hidden + daemon dot bare span` (verify-note: severity low)
- `low · AgentTerminalPane.tsx:183-195 — stop ■ glyph no aria-label`
- `low · apps/console/proxy/proxy.go:120,127-130 — non-running sessions silently hidden; status color-only`

**Fix strategy:** Fix `StatusDot` once — give it `role="img"` + `aria-label` (or a visually-hidden text twin) and a non-color shape/icon cue for OK/warn/error — and every consumer inherits the fix. Ensure each status has a distinct text label (resolve the two-orange StepDeploy states). For the console, render explicit status text per session and list non-running sessions dimmed-but-labeled rather than hiding them. Mostly mechanical once the shared primitive is fixed.

### Theme 9 — Daemon data integrity (non-atomic multi-writes, fail-open identity)
Security-adjacent and coordination-state correctness gaps in the brain.
- `high · packages/daemon/src/server.ts:546-564 — agent identity rotation is 3 non-transactional writes; crash mid-rotation can brick auth` (verify-note: medium — narrow SIGKILL window, self-heals on re-register)
- `high · packages/daemon/src/inference.ts:70-92 — inference.status crashes on unreachable/malformed /api/tags; misreports as "run ollama serve"`
- `high · packages/daemon/src/vcs.ts:163-171 — worktree handlers use the session `task` description column as git cwd; worktrees fail/run in wrong dir`
- `medium · server.ts:1367-1390,344-412 — signature gate fails OPEN (invalid sig == no sig); by-design "P1" but a posture gap`
- `medium · server.ts:404-412 — nonce-replay INSERT catch treats ALL errors as replay; DB fault masquerades as replay`
- `medium · server.ts:722-741 / neon.ts:81-112,245-259 — broadcast/dual-write non-transactional, total_sessions over-counts on every re-register`
- `medium · server.ts:566-592 / 1277-1417 — void-ed revvault persist no .catch; socket.write unguarded + empty error handler (observability gap, crash overstated)`

**Fix strategy:** Wrap every multi-statement mutation on identity/coordination tables in a single transaction (identity bootstrap/rotation, mail.broadcast, Neon upserts) so they are all-or-nothing, and gate the `total_sessions` increment to genuinely-new sessions. Make the signature gate distinguish *present-but-invalid* (reject) from *absent* (fall through) — this is the one item that needs an explicit owner decision since the code comments it as an intentional phase posture. Add shape validation before casting Ollama responses and before slicing SPKI/session-env, and add a dedicated `work_dir` column to `agent_sessions` (populated from `session.register`'s cwd) instead of overloading `task`. Replace the empty `socket.on('error', () => {})` with a logging handler and guard writes with `!destroyed && writable`.

### Theme 10 — Latent hardening (injection foot-guns, unbounded inputs, weak verification)
Real but currently-unreachable or by-design-bounded; defense-in-depth.
- `high · spawner.rs:102-106 (Rust) + spawner.rs (twin) — agent prompt hand-interpolated into JSON; multi-line/backslash prompts corrupt the request` (this one is *user-reachable* — multi-line prompts are common; prioritize within theme)
- `high · proxy.go:94-98 — JSON injection via fmt.Sprintf session name` (verify-note: medium — no untrusted caller today)
- `medium · base58.ts:42-78 — unbounded O(n²) BigInt decode; DoS on multi-KB input`
- `medium · ssh.rs:215-228,123-152 — TOFU learn failure swallowed (fail-open); hashed known_hosts ignored (MITM-detection dead on OpenSSH defaults)`
- `medium · commands/git.rs:504-515 + commands/ssh.rs:147-153 + config.rs:89-97 — path-join no containment; non-atomic file writes (bookmarks/config) corrupt on crash`
- `medium · agents.go:157-178,125-153 — ParseSSEEvents drops malformed events + 64KB scanner cap; 30s client timeout kills SSE streams`
- various `low` — base58/DID asymmetry, safePath lexical-only, PID staleness, etc.

**Fix strategy:** Replace all hand-rolled JSON with `serde_json::json!`/`json.Marshal` (closes both prompt-corruption and the proxy injection foot-gun in one mechanical sweep — and the Rust prompt one is genuinely user-facing). Add length caps to `base58Decode` and raise/guard the SSE scanner buffer + use a non-`Client.Timeout` HTTP client for streaming. Make all config/bookmark writes atomic (temp-file + rename) — same pattern, three sites plus the Rust config. Add path containment (canonicalize + prefix check) to the git/agent file commands as defense-in-depth. The TOFU/known_hosts gaps need a small owner call on how strict to be for a local dev SSH client.

## Prioritized execution order

1. **License doc + tier reconciliation sweep** — Closes Theme 1 (2 critical, 3 high, 3 medium). Purge `RVUI.v2.`/`RVUI-` from all docs, switch to `eyJ` JWT, document `REVDEV_LICENSE_PUBLIC_KEY`, add `session.attach` to `EXEMPT_METHODS`, add `packages/bridge` + build step to README/Getting Started, scope the DB-reset instruction. **Size S, mechanical** (one code touch: `EXEMPT_METHODS`). *Quick high-leverage win — converts every paying first-run customer from silently-broken to working.* Add the doc-lint CI guard in the same PR.

2. **Two hard crashers: Tiles TDZ + Rust agent-wait deadlock** — Closes 2 critical (`use-tiles.ts:198`, `spawner.rs:204-227`). The TDZ is a one-line move (S, mechanical). The deadlock needs the lock restructure (M, needs care but well-specified). *Without these, the Tiles surface and the entire agent panel are unusable.* Do the TDZ immediately, deadlock right after.

3. **events.log refine DoS + console panics** — Closes the remotely-reachable pre-auth daemon crash (`schemas.ts:261` + `validateParams` guard) and the console panic cluster (`proxy.go` done-channel double-close, `sessionID[:8]` slices, error-response-as-success). **Size S–M, mechanical.** Security-critical: the daemon DoS needs no auth.

4. **Mock/degraded-mode banner + no fake secrets** — Closes Theme 2 (1 critical, 2 high, 1 medium). One global degraded flag + one shell banner; stop emitting realistic secret sentinels from `deploy.ts`. **Size M, needs light design** (banner placement/copy). *Critical because a fabricated "live" deploy with placeholder secrets is the worst false-success in the product.*

5. **Reusable destructive-confirm + dismiss/commit separation** — Closes Theme 3 (2 critical, 2 high, 4 medium). One `ConfirmDialog` (with type-to-confirm variant), wired through vault-delete, git-discard, daemon-stop, snap/model-delete, bookmark-delete, DB-migrate/seed, and SetupWizard dismiss. **Size M, needs design** (which actions get type-to-confirm). *Highest count of irreversible-data-loss findings.*

6. **Bound every wait + lifecycle authority** — Closes most of Theme 6 (5 high + mediums). Add `AbortSignal.timeout` to all unbounded fetches, fix the SSH channel-mutex-across-wait hang, fire-and-forget Neon dual-writes off the RPC hot path, add WS timeout+auth, add SIGKILL escalation + reachability-gated daemon start, add agent kill-on-drop/exit, replace `reset --hard` E:\repos sync. **Size L, mostly mechanical with two design-ish bits** (Neon decoupling, daemon PID authority). *The SSH hang and Neon-stalls-every-RPC are daily-driver blockers.*

7. **Deploy wizard state model** — Closes Theme 7 highs. Persist+rehydrate WizardData (esp. one-time KEK/RSA), gate nav on prerequisites, honest verify (real email test, loud admin-push skip), cancel/progress on deploy, checkmark refresh. **Size L, needs design** (secret persistence storage). *Durability-critical: losing a generated KEK can make encrypted data unrecoverable.*

8. **Error-contract sweep (React hooks + libs + console)** — Closes Theme 4 + console twins. Shared `httpRequest` helper (res.ok + 4xx/5xx/network split + guarded json), mutation try/catch contract, PTY send/resize catch→onDisconnect, replace `void fn()` with `.catch`, map raw Go errors to actionable messages. **Size L, mostly mechanical**, plus the lint guards. *Broad UX lift; lower individual severity but huge cumulative trust impact.*

9. **Daemon data integrity** — Closes Theme 9. Transactions on identity/broadcast/Neon writes, gate session counter, Ollama/SPKI/session-env shape validation, dedicated `work_dir` column, fail-closed signature decision (owner-gated), nonce-error classification, socket-write guards + real error logging. **Size M–L, needs one owner decision** (signature fail-open posture).

10. **Latent hardening sweep** — Closes Theme 10. `serde_json`/`json.Marshal` everywhere (incl. the user-reachable Rust prompt corruption — bump this one's urgency, it's not really latent), base58 length cap, SSE buffer+streaming-client, atomic file writes, path containment, known_hosts/TOFU strictness (owner-gated). **Size M, mostly mechanical.**

11. **Accessibility pass** — Closes Theme 8. Fix `StatusDot` once (role/aria-label + shape cue), distinct status labels, console session-status text. **Size S–M, mechanical** once the shared primitive is fixed.

12. **Remaining medium/low polish** — zero-states (AppsPanel, DeployDashboard), edit-to-unlock on locked inference inputs, OTP resend cooldown, local-mode exit affordance, hardcoded `~/projects/RevealUI` default → empty, DiffView error-as-content, push/pull error auto-dismiss, per-repo sync state, etc. **Size M aggregate, mechanical.**

## Map to existing plan

**Tracked workstreams (these themes have a home):**
- **W1 (launch readiness)** absorbs Theme 1 (license docs), Theme 2 (mock banner), Theme 5 (crashers), and the deploy-wizard highs in Theme 7 — these are squarely "can a customer succeed on first run." The H9 (pricing) known gap maps to the console pricing-fallback finding (`model.go:127-132`).
- **W2 (DID/Ed25519 per-RPC signing)** owns the signature/identity findings in Theme 9: the fail-open gate (`server.ts:1367-1390`), non-atomic identity rotation (`server.ts:546-564`), nonce-replay misclassification (`server.ts:404-412`), bridge signing fail-open (`client.ts:26-65`), and the DID/base58/actorAgentId validation asymmetries. W2 is the natural owner for "make signing fail-closed."
- **W3 (cross-machine coordination)** owns the Neon dual-write findings: hot-path stalls (`server.ts` await sites), non-transactional broadcast/upserts, `total_sessions` over-count, and the missing sync-failure metric (`neon.ts:14-16`). H4 (release endpoint) is orthogonal to these findings — none here touch it.
- **W4 (Studio dogfood @revealui/presentation)** intersects Theme 3/8 since the confirm dialogs and StatusDot are presentation-layer primitives; the dogfood effort should adopt the new `ConfirmDialog`/`StatusDot` rather than the deploy-wizard's local patterns.
- **W5 (Console)** owns the entire Go proxy/TUI cluster: the false-fallback dead-end, channel double-close panic, `sessionID[:8]` slices, WS timeout/auth, JSON injection, SSE parsing, raw-error display, free-tier no-op. This is a large, coherent W5 batch.
- **W7 (synchronous messaging)** touches the MessageInbox empty-state and mail.broadcast atomicity findings.

**NET-NEW / untracked (must be added to the plan):**
- **A "destructive-action confirmation" workstream** — there is no tracked home for the confirm-dialog primitive spanning vault/git/daemon/inference/setup. This is a cross-cutting net-new item (Theme 3, 2 critical + 2 high). **Add it.**
- **A "degraded/mock-mode visibility" item** — the global degraded flag + banner is net-new and spans Studio shell, deploy, config, invoke, and console. **Add it.**
- **The Rust Tauri backend reliability cluster** — agent-wait deadlock, kill-on-drop/orphans, tray panic, poisoned platform Mutex, config non-atomic write, SSH channel-hang, daemon_ctl lifecycle (SIGKILL/PID authority/stale-PID). This is a substantial untracked surface; W1 mentions "launch readiness" but the Rust supervision/lifecycle layer isn't called out. **Add a Tauri-backend hardening lane.**
- **The error-contract sweep (Theme 4)** — the React-hooks/lib silent-failure pattern isn't a named workstream. **Add it**, with the lint guards as the durable enforcement.
- **A docs-accuracy CI gate** — beyond fixing the docs once, the doc-vs-code drift guard (grep for rejected formats, verify env-var coverage) is net-new tooling. **Add it.**
- **Accessibility** — Theme 8 has no tracked owner. The shared-primitive fix is small but net-new. **Add it.**

## Risks / watch-items

- **Signature fail-open is an owner decision, not a clean fix.** The code comments it as an intentional "P1/accept-if-present" phase. Flipping invalid-signature to reject (vs absent → fall through) changes the security posture and could break any client currently sending malformed signatures. **Owner must decide** whether W2's phase has reached "enforce." Per the global posture ("fail-closed where security demands"), the recommendation is to reject present-but-invalid; but it needs an explicit go.

- **TOFU/known_hosts strictness for the Studio SSH client.** Supporting hashed known_hosts and failing-closed on TOFU-learn failure is the correct security stance, but this is a *local dev SSH client*, and stricter behavior could surprise users whose `~/.ssh/known_hosts` is hashed (OpenSSH default on many distros). **Owner call** on how aggressively to enforce vs warn.

- **Deploy-wizard secret persistence introduces a new at-rest secret store.** Persisting the generated KEK/RSA private key to survive reload is durability-critical, but *where* (vault? encrypted config?) and the threat model around it is a design decision with security weight — do not pick a location without owner sign-off, and never persist to plaintext config.

- **RvuiUpgradePanel collects payment for a cancelled product (RVC/RevealCoin, keys destroyed 2026-05-29).** `RvuiUpgradePanel.tsx:33-62` POSTs real payment for a coin that no longer exists. This is gated behind a Solana-wallet setting so it's not shown by default, but it's reachable shipping code asking users to send funds to a dead wallet. **The fix is deletion, not patching** — but confirm the entry point/mount status with the owner first (the verify-note flagged the import site as unverified). High-severity, but the action is "remove," which needs an owner nod.

- **The `total_sessions` over-count has already polluted any live Neon admin surface.** Fixing the increment going forward doesn't repair historical inflated counts — if any fleet dashboard reads this, **a one-time reconciliation/backfill may be needed**, which is data work, not a code fix.

- **Neon dual-write decoupling changes shutdown/consistency semantics.** Moving the awaited dual-writes off the RPC hot path is correct, but it widens the window where Neon lags PGlite. This is acceptable per the documented "PGlite is source of truth, Neon is additive mirror" posture, but the missing **sync-failure metric** (and the deferred offline-replay, Phase 6) should land alongside so the lag is observable. Watch that "fire-and-forget" doesn't silently become "permanently divergent with no alert."

- **The console JSON-injection (`proxy.go:94-98`) and Rust prompt-corruption (`spawner.rs:102-106`) share a root cause but differ in urgency.** The Rust one is genuinely user-reachable (multi-line prompts are normal) and should not sit in the "latent" theme; the Go one has no untrusted caller today. Don't let the shared `serde_json`/`Marshal` framing cause the user-facing Rust one to be deprioritized.

## Execution task breakdown (for the WSL-native executor)

Work the items in order. Each is its own branch off `test`, its own PR (base `test`, never `main`), manual merge (no `--auto`). Audit-first: re-read the cited code before each change. Items flagged owner-gated must not be auto-picked-up without sign-off.

| # | Task | Closes | Size | Type | Suggested branch | Owner-gated |
|---|------|--------|------|------|------------------|-------------|
| 1 | License doc + tier sweep: purge `RVUI.v2.`/`RVUI-` from all docs, switch to `eyJ` EdDSA JWT, document `REVDEV_LICENSE_PUBLIC_KEY`, add `session.attach` to `EXEMPT_METHODS` (`license.ts:63-69`), add `packages/bridge` build step to README+Getting Started, scope the DB-reset warning, add a CI doc-lint that fails on `RVUI.v2.`/`RVUI-` | Theme 1 (2 crit, 3 high, 3 med) | S | mechanical (+1 code touch) | `fix/license-docs-and-exempt` | no |
| 2 | Two hard crashers: move `allTiles` const above first use (`use-tiles.ts:193-198`); restructure `spawner.rs:204-227` so the `sessions` Mutex is not held across `child.wait()` | 2 critical | S + M | TDZ mechanical, deadlock careful | `fix/studio-crashers` | no |
| 3 | Remote pre-auth daemon DoS (`schemas.ts:259-264` — guard the refine `JSON.stringify`, wrap `validateParams` in the socket handler) + console panics (`proxy.go` done-channel double-close, `sessionID[:8]` slices, error-as-success) | 1 high (DoS) + console cluster | S–M | mechanical | `fix/daemon-dos-and-console-panics` | no |
| 4 | One global degraded/mock-mode flag + one persistent shell banner; stop emitting realistic secret values from mocks (`deploy.ts`, `invoke.ts` MOCK_DATA, `config.ts`, console pricing fallback) | Theme 2 (1 crit, 2 high, 1 med) | M | light design (banner copy/placement) | `feat/degraded-mode-banner` | no |
| 5 | One reusable `ConfirmDialog` (with type-to-confirm variant) wired through every destructive action: vault delete, git discard-all, daemon stop/restart, snap/model delete, SSH bookmark delete, DB migrate/seed; separate SetupWizard dismiss from setup-complete | Theme 3 (2 crit, 2 high, 4 med) | M | design (which need type-to-confirm) | `feat/destructive-confirm` | no |
| 6 | Bound every wait + lifecycle authority: `AbortSignal.timeout` on all unbounded fetches; fix SSH channel-mutex-across-`wait()` hang (`ssh.rs:346-395`); fire-and-forget Neon dual-writes off the RPC hot path; WS HandshakeTimeout + auth header; SIGKILL escalation + reachability-gated daemon start; agent kill-on-drop/exit; replace `reset --hard` E:\repos sync with `pull --ff-only` | Theme 6 (5 high + med) | L | mostly mechanical, 2 design-ish | `fix/timeouts-and-lifecycle` | no |
| 7 | Deploy wizard state model: persist + rehydrate `WizardData` (esp. one-time KEK/RSA keys), gate nav on prerequisite completion, honest verify (real email test or "Not verified", loud fail when `apiProjectId` missing), `AbortController` + progress/cancel on deploy, push `completeStep` return into `useConfig` | Theme 7 highs | L | design (secret persistence location) | `feat/deploy-wizard-durability` | YES (where to store generated secrets at-rest) |
| 8 | Error-contract sweep: shared `httpRequest` helper (`res.ok` + 4xx/5xx/network split + guarded `json()`) routed through auth/health/billing/httpRpc; mutation try/catch contract in hooks; PTY/SSH send+resize catch→onDisconnect; replace `void fn()` with `.catch`; map raw Go errors to actionable text; lint banning bare `catch {}` + void-ed promises in hooks/ + lib/ | Theme 4 + console twins | L | mostly mechanical + lints | `refactor/error-contract` | no |
| 9 | Daemon data integrity: wrap identity bootstrap/rotation, mail.broadcast, Neon upserts in single transactions; gate `total_sessions` to genuinely-new sessions; shape-validate Ollama/SPKI/session-env before cast; dedicated `work_dir` column (stop overloading `task` as git cwd, `vcs.ts:163-171`); classify nonce-replay vs DB fault; guard socket.write + real error logging | Theme 9 | M–L | needs 1 owner decision | `fix/daemon-data-integrity` | YES (signature fail-open → reject posture) |
| 10 | Latent hardening: replace hand-rolled JSON with `serde_json::json!` / `json.Marshal` (PRIORITIZE the user-reachable `spawner.rs:102-106` prompt corruption — multi-line prompts are normal); base58 length cap; SSE buffer + non-`Client.Timeout` streaming client; atomic temp-file+rename for config/bookmark writes; path containment on git/agent file commands | Theme 10 | M | mostly mechanical | `hardening/json-bounds-atomic` | YES (known_hosts/TOFU strictness) |
| 11 | Accessibility: fix `StatusDot` once (`role="img"` + `aria-label` + non-color shape/icon cue); distinct text labels per status (resolve two-orange StepDeploy states); console per-session status text | Theme 8 | S–M | mechanical | `a11y/status-primitives` | no |
| 12 | Polish tail: zero-states (AppsPanel, DeployDashboard), edit-to-unlock on locked inference inputs, OTP resend cooldown, local-mode exit affordance, `~/projects/RevealUI` default → empty, DiffView error-as-content, push/pull error auto-dismiss, per-repo sync state | medium/low remainder | M (aggregate) | mechanical | `chore/ux-polish` | no |

### Separate owner-gated removal (not in the ordered list)
- **`apps/studio/src/components/subscription/RvuiUpgradePanel.tsx:33-62`** POSTs real payment for RevealCoin / RVC, which was **cancelled 2026-05-29 with signing keys destroyed**. The correct fix is **deletion of the panel + its entry point**, not patching. Confirm the mount/entry point with the owner first (the verifier flagged the import site as unverified), then remove.


## Appendix — all 182 confirmed findings

Sorted by severity, then surface. Each was re-verified against the cited code.

### CRITICAL (7)

- **`apps/studio/src/hooks/use-tiles.ts:193-198`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-tiles: allTiles referenced before declaration (temporal dead zone)
  - Impact: Every render of the Tiles surface throws `ReferenceError: Cannot access 'allTiles' before initialization`, which crashes the React subtree (and, without an error boundary, the whole Studio window). The Tiles dashboard is unusable.
  - Fix: Move the `const allTiles = [...DEFAULT_TILES, ...detectedProfiles];` declaration above the `recentTiles` computation (before line 193).
- **`apps/studio/src/lib/deploy.ts:10-145`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Browser/mock mode silently fakes every deploy step as success with zero indication
  - Impact: Run in a browser the entire wizard walks green to 'All checks passed! Your RevealUI instance is live' with placeholder secrets. An operator can believe a real deployment happened then push placeholder secrets/keys into a real env.
  - Fix: When isTauri() is false, surface a persistent prominent 'Browser preview - actions are mocked' banner across the wizard and disable/tag the mocked actions; never return realistic-looking secret values.
- **`apps/studio/src/components/agent/AgentPanel.tsx:411-420`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Git Discard All / Discard file is destructive with no confirmation
  - Impact: Clicking 'Discard All' (or a per-file discard icon that appears on hover) permanently throws away uncommitted working-tree edits — potentially hours of work — with no confirm and no undo. git provides no recovery for discarded unstaged changes.
  - Fix: Require a confirmation dialog before discardAll and before per-file discard, showing the file count/paths. This is the highest-blast-radius action in the panel.
- **`apps/studio/src/components/vault/SecretList.tsx:34-53`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Vault secret deletion has no confirmation and no undo
  - Impact: A single mis-aimed hover-click permanently destroys a stored secret (API key, token, credential) with zero warning and no way to recover it. The delete icon only appears on hover, so it is easy to hit by accident while reaching for the row.
  - Fix: Gate deletion behind a confirmation dialog (reuse Modal) that shows the secret path, or require typing the key name to confirm. At minimum show a destructive-action confirm before calling vaultDelete.
- **`apps/studio/src-tauri/src/spawner.rs:204-227`** _[durability · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - Agent wait-thread holds global sessions Mutex across blocking child.wait(), deadlocking all other agent RPCs
  - Impact: While any spawned agent (ollama/curl) is running, the SpawnerState Mutex is held continuously by the wait thread. Every other agent command — agent_spawn (insert), agent_stop, agent_list, agent_remove — calls state.lock() and blocks indefinitely. The whole agent panel hangs; the user cannot list, stop, or start any agent until the running one exits on its own. With a long-running ollama session this is an unbounded UI hang and the user has no way to kill the agent (stop also blocks on the same lock).
  - Fix: Do not hold the lock across wait(). Move the Child out of the map (or wrap it so wait() can run unlocked): take the lock only to clone/remove the relevant handle, drop the guard, then call child.wait(); re-acquire the lock briefly to write back proc.status. Alternatively store the Child behind its own Arc<Mutex<Child>> per session so the wait thread locks only that session's child, never the whole HashMap.
- **`docs/GETTING_STARTED.md:92-98`** _[durability · User-facing docs accuracy (cross-checked against code)]_
  - Docs tell users to set a license key format the daemon explicitly rejects
  - Impact: A paying customer who follows Getting Started verbatim will paste an RVUI.v2.* key, restart the daemon, and silently stay on FREE tier; every Pro RPC returns -32001 'License required' with no hint that the documented key format is the cause.
  - Fix: Rewrite the License Activation section to state keys are Ed25519-signed JWTs starting with `eyJ`, and change the example to `export REVEALUI_LICENSE_KEY="eyJhbGci..."`. Match the format described in license-crypto.ts and scripts/issue-license.ts.
- **`docs/TROUBLESHOOTING.md:107-112`** _[durability · User-facing docs accuracy (cross-checked against code)]_
  - Troubleshooting 'License key doesn't activate' instructs the user to verify a rejected format
  - Impact: A user debugging a non-activating license is told their correctly-formatted `eyJ...` key is wrong because it doesn't start with `RVUI.v2.`, and may discard a valid key or contact support with a false diagnosis.
  - Fix: Change the format check to: key must start with `eyJ`; format is a three-part base64url JWT `<header>.<payload>.<signature>` with `alg: EdDSA`. Remove all `RVUI.v2.` references.

### HIGH (44)

- **`apps/console/proxy/proxy.go:50-55`** _[ux · Console Go TUI (payment/licensing/proxy)]_
  - Agent-proxy 'falling back to payment TUI' message is a lie; session dead-ends
  - Impact: An operator connecting with `ssh ... agents` when the daemon is unreachable sees 'daemon unreachable' then 'Falling back to payment TUI...' and is immediately disconnected. The promised fallback never happens; the screen lies and the session is a dead end with no retry path.
  - Fix: Either actually invoke the payment TUI on proxy failure (have Handle return a sentinel so the middleware calls next(s)), or remove the false 'Falling back' message and replace it with an actionable retry/quit prompt.
- **`apps/console/proxy/proxy.go:94-98`** _[durability · Console Go TUI (payment/licensing/proxy)]_
  - JSON injection in spawnSession via unescaped session name
  - Impact: If name ever contains a quote, backslash or control char (e.g. from a future caller or a session count rendered oddly), the POST body becomes malformed JSON and the spawn silently fails with an opaque 'decode spawn response' error. Brittle and an injection foot-gun.
  - Fix: Marshal a typed struct: `body, _ := json.Marshal(map[string]any{"name": name, "cols": 120, "rows": 30})` and POST bytes.NewReader(body).
- **`apps/console/proxy/proxy.go:98-110`** _[durability · Console Go TUI (payment/licensing/proxy)]_
  - spawnSession ignores HTTP status; treats error responses as success
  - Impact: On an auth or server error, the user sees 'Session created: ' then bridge() does `sessionID[:8]` on an empty string and panics (slice bounds out of range), killing the SSH session with no message. Or it connects to ws/<empty> and hangs.
  - Fix: Check resp.StatusCode != http.StatusOK before decoding and return a clear error; also guard sessionID != "" before slicing.
- **`apps/console/proxy/proxy.go:129, 158, 177`** _[durability · Console Go TUI (payment/licensing/proxy)]_
  - sessionID[:8] panics on short or empty session IDs
  - Impact: If the daemon returns a session with an ID shorter than 8 chars (or empty after a failed spawn), the proxy panics with 'slice bounds out of range' and the operator's SSH session is killed abruptly with no error shown.
  - Fix: Add a safe truncation helper (e.g. `short(id string) string` returning id when len<8) and use it at all three sites.
- **`apps/console/proxy/proxy.go:179`** _[durability · Console Go TUI (payment/licensing/proxy)]_
  - WebSocket dial has no timeout and no Origin/auth header; can hang forever
  - Impact: If the WS endpoint is unreachable or slow, the dial hangs indefinitely after printing 'Connecting to...', leaving the operator staring at a frozen screen with no cancel. If the endpoint requires the service token, every connect fails with a raw 'WebSocket dial failed' and no recovery.
  - Fix: Use a dialer with HandshakeTimeout set, and pass an http.Header carrying `Authorization: Bearer <serviceToken>` (the proxy already holds the client/token).
- **`apps/console/proxy/proxy.go:188-241`** _[durability · Console Go TUI (payment/licensing/proxy)]_
  - bridge double-closes 'done' channel — panic on concurrent close
  - Impact: Race condition where simultaneous disconnect on both directions panics the proxy and kills the SSH session uncleanly (and can leak the websocket since defers may not run on panic in a goroutine — the whole process can crash since a panic in a goroutine is unrecoverable).
  - Fix: Use sync.Once for closing done, or a context.CancelFunc, so every close path is idempotent.
- **`packages/daemon/src/server.ts:546-564`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - bootstrapAgentIdentity performs 3 sequential writes (supersede old key, insert new key, update identity) with no transaction — a crash between writes leaves identity tables inconsistent
  - Impact: After a crash mid-rotation, that agent can never authenticate a signed envelope: verifyOrWarn (370-374) only matches keys WHERE superseded_at IS NULL. Every signed RPC falls through to 'signature unknown key' and is silently downgraded to unsigned.
  - Fix: Wrap the supersede+insert+update (and the fresh-insert pair) in a single `db.transaction(...)` so key-table mutations are atomic.
- **`packages/daemon/src/server.ts:491, 651, 699, 734, 767, 814, 843, 853, 889, 946, 973, 991, 1008`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - Periodic Neon dual-writes inside RPC handlers are awaited in the handler hot path, so a slow/hanging Neon endpoint stalls the RPC despite being 'best-effort'
  - Impact: When POSTGRES_URL points at a slow/partitioned Neon, every coordination RPC hangs for the full HTTP/TCP timeout even though PGlite already committed. The handlers hold _activeHandlerCount > 0, so daemon close() blocks the full shutdownGracePeriodMs then force-closes PGlite under them.
  - Fix: Either fire-and-forget the sync helpers with a `.catch()`, or wrap each Neon call in an AbortController/timeout so a hung endpoint cannot block the RPC or shutdown drain.
- **`packages/daemon/src/validation/schemas.ts:259-264`** _[durability · Daemon identity / license / RPC validation]_
  - events.log payload refine throws (uncaught) on un-stringifiable payloads, crashing the validator
  - Impact: An events.log payload containing a BigInt or a circular object makes validateParams() throw instead of returning a clean -32602. The throw escapes the schema.safeParse call (validation/index.ts:33, no try/catch) and the validateParams call in the async socket data handler (server.ts:1348, no try/catch), surfacing as an unhandled rejection in the per-socket handler rather than a clean Invalid params response. Trivially reachable over the JSON-RPC socket as a DoS.
  - Fix: Guard the size check: wrap JSON.stringify in try/catch and return false on throw (and treat undefined result as 0/invalid), or constrain payload to JSON-safe primitives via z.record/z.array before measuring. The predicate must never throw.
- **`packages/daemon/src/inference.ts:70-92`** _[durability · Daemon storage / migrations / dual-write / observability]_
  - inference.status crashes when /api/tags is unreachable or malformed
  - Impact: A partially-broken Ollama (up but returning bad /api/tags) makes inference.status throw, caught only by the generic catch which returns the misleading 'Cannot connect to Ollama. Run: ollama serve' even though Ollama is running — health probe becomes unreliable and the operator chases the wrong cause.
  - Fix: Check modelsRes.ok before parsing; wrap each .json() in its own try/catch; default models.models to [] via (models.models ?? []).map(...).
- **`packages/daemon/src/vcs.ts:163-171, 182-187, 227-228`** _[durability · Daemon storage / migrations / dual-write / observability]_
  - vcs worktree handlers use the session `task` column as the working directory
  - Impact: Worktree create/remove runs git in a directory named after free-form task text (e.g. '(starting)'), so git fails ENOENT, or worse runs in the wrong repo if the text happens to match a real relative path. Agents cannot reliably create worktrees; the surfaced error is confusing git stderr.
  - Fix: Add a dedicated work_dir/repo-root column to agent_sessions (populated from session.register's cwd), read it in agentWorkDir, and validate it is an existing absolute directory before spawning git.
- **`packages/bridge/src/client.ts:26-36, 46, 54-65`** _[durability · Protocol + bridge (RPC types, signing, DID, MCP/daemon client)]_
  - Signing config resolution fails open — invalid/missing agent key silently downgrades to unsigned RPC
  - Impact: An operator intending a signed/identity-bound bridge can ship it unsigned due to a key/env typo, with only a console.warn. RPCs then carry no DID/nonce, defeating per-RPC identity. Identity should fail-closed; this fails open.
  - Fix: Add a REVDEV_REQUIRE_SIGNING flag (default on for non-dev) so resolveSigningConfig throws / call() refuses when signing is required but config is null, surfacing an actionable error.
- **`apps/studio/src/hooks/use-apps.ts:7-22, 47-55, 72-80`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-apps: pollUntil keeps running and calling setApps after unmount (leak + post-unmount work)
  - Impact: If the user navigates away or closes the window during the up-to-10s start/stop poll, the loop keeps issuing daemon RPCs in the background and `refresh()` (a usePollingFetch runOnce) fires against a torn-down tree. Wasted RPC traffic and post-unmount work on this code path.
  - Fix: Thread an AbortController (or an isMounted ref) into `pollUntil` and check it inside the `while` loop and before the trailing `refresh()`; abort it in a useEffect cleanup or when the action's component unmounts.
- **`apps/studio/src/hooks/use-local-shell.ts:107-117`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-local-shell: send/resize fire RPC with no try/catch — same unhandled-rejection pattern
  - Impact: Typing into or resizing a local shell whose PTY has already exited produces an uncaught promise rejection with no UI signal. The user perceives a frozen terminal that silently eats input.
  - Fix: Wrap both invokes in try/catch and surface the error via `setState`/`onExit`, mirroring how `close` already tolerates a gone session.
- **`apps/studio/src/hooks/use-ssh.ts:124-136`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-ssh: send/resize fire RPC with no try/catch — unhandled rejection on a dead session
  - Impact: On every keystroke or terminal resize against a connection that died mid-session, the invoke rejects uncaught -> unhandledrejection. The terminal gives no feedback that input is being dropped; the user keeps typing into a dead session.
  - Fix: Wrap `sshSend`/`sshResize` in try/catch; on failure set `state.error` (or invoke `onDisconnect`) so the UI reflects that the session is gone, rather than silently swallowing or crashing.
- **`apps/studio/src/hooks/use-vault.ts:105-124`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-vault: createSecret/deleteSecret have no error handling — unhandled promise rejection
  - Impact: If the Rust vault backend rejects a write/delete (locked vault, disk full, permission denied, daemon down), the promise rejects uncaught. The user sees no error in the UI, the secret list is not refreshed, and the calling component's await throws — typically surfacing as an unhandledrejection and a silently failed save. The operator believes a secret was stored when it was not (data loss).
  - Fix: Wrap both bodies in try/catch and `setState((prev) => ({ ...prev, error: ... }))` on failure, matching the pattern in `init`/`selectSecret`. Do not call `refresh()` on the failure path.
- **`apps/studio/src/components/infrastructure/DaemonPanel.tsx:111-128`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - Daemon Stop/Restart are destructive with no confirmation
  - Impact: An operator can single-click Stop and instantly tear down the daemon (and every running agent session it supervises) with no 'Are you sure?' and no undo. A mis-click loses live work.
  - Fix: Wrap Stop and Restart in a confirmation modal warning that active agent sessions will be terminated, requiring explicit confirm before invoking daemonStop()/daemonRestart().
- **`apps/studio/src/lib/invoke.ts:479-482`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - Browser/mock-mode data is rendered as real status with no indicator
  - Impact: Running Studio in a browser shows green 'running' WSL/Systemd cards and a 'pro' tier badge that are entirely fabricated. An operator can mistake mock data for the real system state and believe services are up when nothing is actually running.
  - Fix: Have invoke() set a global 'mock mode' flag when it falls back to MOCK_DATA, and render a persistent banner (e.g. in Dashboard/AppShell) stating 'Demo data — not connected to a real system' whenever mock mode is active.
- **`apps/studio/src/components/deploy/DeployWizard.tsx:108-147`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Sidebar lets user jump to any later step, bypassing required prerequisite data
  - Impact: Jumping straight to Deploy with empty WizardData runs handleDeploy which errors 'Missing project IDs' or pushes empty-string env vars and deploys, leading to broken half-configured deployments.
  - Fix: Disable/gate nav buttons for steps whose prerequisites are incomplete, and/or have goTo refuse forward jumps past the first incomplete step.
- **`apps/studio/src/components/deploy/DeployWizard.tsx:44-57`** _[durability · Studio deploy wizard (multi-step flow)]_
  - All wizard data lives in volatile component state and is lost on any reload, with no draft persistence
  - Impact: If the app closes/crashes/reloads after generating secrets but before Deploy, the generated REVEALUI_KEK/RSA keypair and tokens are gone permanently. On resume the wizard lands on a later completed step with empty data, so deploy pushes blank env vars or fails. No way to recover the one-time generated secrets.
  - Fix: Persist WizardData (or at least irreversible generated secrets/keys) to secure config storage as steps complete, and rehydrate data from config on mount.
- **`apps/studio/src/components/deploy/StepDatabase.tsx:50-57`** _[durability · Studio deploy wizard (multi-step flow)]_
  - StepDatabase runs irreversible migrate + seed with no confirmation and a hardcoded '.' repo path
  - Impact: Pointing the wizard at a populated/production database and clicking 'Connect & Migrate' silently runs migrations and a seed against it — destructive with no 'are you sure'. The '.' path depends on the Tauri backend CWD being the repo root; otherwise migrate/seed silently target the wrong/no repo.
  - Fix: Split connection-test from migrate/seed, require explicit confirmation before seeding, and pass an explicit resolved repo path instead of '.'.
- **`apps/studio/src/components/deploy/StepDeploy.tsx:21-24, 154-168, 204-250`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Long deploy (up to 5 minutes per app) has no cancel and no per-app progress beyond a status word
  - Impact: An operator can wait five minutes per app with no progress sense and no way to abort a stuck/wrong deploy. The only escape is killing the app, losing all wizard state.
  - Fix: Show attempt/elapsed progress and add a Cancel button wired to an AbortController that stops the poll loop and resets app status.
- **`apps/studio/src/components/deploy/StepVerify.tsx:62-72, 101-112, 183-200`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Verify step reports 'All checks passed' and admin creation even when env vars or admin push silently no-op
  - Impact: Operator is told email delivery passed and instance is live when email was never tested and (if api project id missing) no admin env was pushed. False all-green sign-off leading to a 'live' site where login/email is broken.
  - Fix: Make Email Delivery actually test send (or label 'Not verified - test from Admin'), and fail/warn loudly when apiProjectId is missing instead of silently skipping the admin env push.
- **`apps/studio/src/hooks/use-deploy-wizard.ts:33-37`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Sidebar step checkmarks never update during a session because in-memory config is not refreshed after completeStep
  - Impact: As the operator advances, completed steps never turn green/checked in the left nav within the session; completion only appears after a full app reload. Undermines the only progress signal.
  - Fix: Have markComplete/next push the updated config back into useConfig state (completeStep already returns the updated config — call updateConfig with it), or track completed steps in local wizard state.
- **`apps/studio/src/components/intent/IntentScreen.tsx:59-64`** _[ux · Studio first-run / onboarding / shell]_
  - Intent selection silently dead-ends if config write fails
  - Impact: If the Tauri `set_config` invoke fails (disk/permission error), the user clicks Continue on the first-run welcome screen and nothing happens — no spinner, no error, no advance. The onboarding is a hard dead-end with zero feedback.
  - Fix: Make IntentScreen show a pending state while onSelect resolves and render a failure message if it rejects; have onSelect propagate the rejection (don't swallow in use-config), and surface use-config's `error` somewhere the user sees it.
- **`apps/studio/src/lib/auth-api.ts:68-77`** _[ux · Studio first-run / onboarding / shell]_
  - HTTP error responses are not checked, masking real auth failures as generic network errors
  - Impact: A rate-limited OTP request, an expired/blocked account, or a server 500 all show the user 'Unable to reach the RevealUI API' or 'Invalid verification code' — wrong, unactionable diagnoses during the very first thing a user does. They will retry endlessly against a server that is up but rejecting them.
  - Fix: In request(), check `if (!res.ok)` and surface the HTTP status plus the parsed error body (`{ error }`) when present; only translate genuine fetch rejections (TypeError) to 'Unable to reach the RevealUI API'. Distinguish 4xx (actionable: bad code, rate limit) from 5xx (server) in the messages shown by use-auth.ts.
- **`apps/studio/src/lib/config.ts:16-31`** _[ux · Studio first-run / onboarding / shell]_
  - Browser/mock config is served as real config with no indication
  - Impact: In browser/dev mode the full onboarding renders as if real, every choice is silently lost on reload (memory-only), and the user/operator gets no signal they are not talking to the real backend. Mock-mode state is indistinguishable from a persisted desktop session.
  - Fix: Render a persistent 'browser/mock mode — settings not saved' banner when `!isTauri()`, and/or persist the browser-mode config to localStorage so choices survive reload. At minimum log/surface that setConfig is a no-op outside Tauri.
- **`apps/studio/src/components/agent/AgentPanel.tsx:392-396`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Git stage/unstage/discard chains drop errors — failures vanish silently
  - Impact: If staging or discarding a file fails (locked file, merge in progress, permission), the file list refreshes and the change is simply still there with no error — the operator cannot tell whether the action worked or why it didn't.
  - Fix: Add try/catch to stageFile/unstageFile/discardFile/stageAll/discardAll and set gitError on failure.
- **`apps/studio/src/components/subscription/RvuiUpgradePanel.tsx:33-62`** _[durability · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - RvuiUpgradePanel collects real payments for RevealCoin, which is a cancelled product
  - Impact: Operators are presented a live payment flow asking them to send RevealCoin to 'the platform wallet' for a coin that no longer exists/operates — risking lost funds and a broken/confusing checkout that cannot succeed.
  - Fix: Remove or hard-gate the RVUI/RevealCoin upgrade path behind the cancelled-product flag so it is not reachable in the shipping UI; if RVUI is fully dead, delete the panel and its entry point.
- **`apps/studio/src/components/terminal/SshBookmarkSidebar.tsx:41-51`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - SSH ConnectForm host key handling: password bookmark connect sends empty password with no prompt
  - Impact: Clicking Connect on a saved password bookmark attempts an SSH login with an empty password, which fails. The user gets a confusing auth failure for a connection they 'saved', with no obvious way to enter the password from the sidebar.
  - Fix: For password-auth bookmarks, route through the ConnectForm pre-filled (host/user/port) with the password field focused, instead of connecting with an empty password.
- **`apps/studio/src/components/terminal/SshBookmarkSidebar.tsx:53-56`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Bookmark delete (sidebar and form) is destructive with no confirmation and no error feedback
  - Impact: A single click permanently removes a saved connection (host, user, key path) with no confirmation. If the delete RPC fails, the bookmark reappears with no explanation since errors are swallowed.
  - Fix: Confirm before deleting a bookmark and surface delete failures (try/catch → visible error).
- **`apps/studio/src/hooks/use-vault.ts:113-124`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Vault delete failure is silently swallowed — UI shows nothing
  - Impact: If deletion fails (daemon down, permission error, secret locked), the row stays on screen with no error message. The operator believes nothing happened, may retry or assume the secret still exists, and never sees why it failed.
  - Fix: Wrap vaultDelete in try/catch and surface the message via the existing `error` state (rendered by ErrorAlert in VaultPanel), the same way createSecret/selectSecret errors are handled.
- **`apps/studio/src/lib/invoke.ts:442-446`** _[durability · Studio transport / API client lib (invoke tri-mode, api wrappers)]_
  - httpRpc fetch has no timeout — remote-daemon calls hang the UI forever
  - Impact: If the daemon is TCP-reachable but stalls (half-open conn, hung RPC, black-hole), the promise never settles; harness/agent/inference panels spin forever with no error or recovery short of restarting Studio.
  - Fix: Add `signal: AbortSignal.timeout(N)` (mirror the 5s in health-api.ts / a2a-api.ts) and surface AbortError as an actionable 'daemon timed out' message.
- **`apps/studio/src/lib/tiles.ts:387-396`** _[durability · Studio transport / API client lib (invoke tri-mode, api wrappers)]_
  - launchTile passes a space-joined command string to shell open() and drops the returned promise
  - Impact: `open` from plugin-shell opens a single path/URL with the OS default handler, not a command executor; the joined string cannot resolve as a launchable target, so shell launcher tiles silently fail. Both open() calls also drop the returned Promise — a rejection (missing handler, permission) becomes an unhandled rejection with no UI feedback.
  - Fix: Use `Command.create(program, args).spawn()` for type:'shell' tiles (same plugin-shell exec path detectBrowserProfiles already uses); reserve open() for type:'url'. Make launchTile async and .catch() failures for a 'failed to launch X' toast.
- **`apps/studio/src-tauri/src/platform/windows.rs:101-143`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - Windows sync_all_repos and git_sync_e reset --hard against E:\repos, an explicitly retired path
  - Impact: Running sync from Studio on a machine that still has an E:\repos checkout `git reset --hard`s it, destroying uncommitted work; on branch-detection failure the reset targets the nonexistent ref origin/- with no detail.
  - Fix: Do not `reset --hard` as a sync primitive on a possibly-edited working tree — use `pull --ff-only` and surface divergence (as git_sync_c does). Guard the `-` branch sentinel before building origin/<branch> and abort with a real error.
- **`apps/studio/src-tauri/src/spawner.rs:102-106`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - Agent prompt is interpolated into a JSON body via naive quote-escaping, corrupting the request on common input
  - Impact: Spawning a Snap-backend agent with a multi-line prompt or one containing a backslash (code snippets, Windows paths — extremely common) silently sends a malformed body; the server returns 400 and the agent appears to 'fail to start' with no clear reason.
  - Fix: Build the body via `serde_json::json!({ "model": model, "messages": [{"role":"user","content":prompt}], "stream": false })` then `serde_json::to_string`, and pass that to curl `-d`. Never hand-format JSON.
- **`apps/studio/src-tauri/src/spawner.rs:204-227`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - Agent wait thread holds the sessions Mutex for the entire process lifetime, blocking list/stop/spawn
  - Impact: Once one agent is spawned the agent panel freezes: cannot list, stop, or spawn another until the first process exits on its own. The Stop button deadlocks against the wait thread it is trying to interrupt, so it does nothing.
  - Fix: Do not call blocking `child.wait()` under the shared lock. Move the Child behind its own Arc<Mutex>, or take the child handle out under a brief lock, release, then `wait()`, then re-lock briefly to update status.
- **`apps/studio/src-tauri/src/ssh.rs:346-395`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - SSH connect aborts the channel read loop on a single send-time lock, orphaning the connection silently
  - Impact: Typing into an SSH terminal sitting at an idle prompt does nothing — keystrokes hang until the server emits output, so the terminal feels frozen/unresponsive. This makes the SSH terminal effectively unusable at any idle prompt, which is the common case.
  - Fix: Do not hold the channel mutex across `wait().await`. Give the reader its own clone of the channel half, or drive reads via the already-wired `SshClientHandler::data` callback (ssh.rs:246-261) and drop the polling loop so `ssh_send` can lock immediately.
- **`apps/studio/src-tauri/src/spawner.rs:54-61, 127-155`** _[durability · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - Spawned agent processes have no kill-on-drop and are not killed on app exit — orphaned children
  - Impact: When the user quits Studio (tray Quit -> app.exit(0)) or Studio crashes, every running agent (ollama run / curl) keeps running detached. Repeated Studio restarts accumulate orphaned ollama processes consuming RAM/GPU on a 7.3GB workstation, and the user has no UI to find or kill them.
  - Fix: Add a Drop impl on AgentProcess that calls child.kill()/wait(), and/or register an app exit handler (RunEvent::ExitRequested / Exit in lib.rs) that locks SpawnerState and kills all running children before exiting. Also kill on tray `quit` before app.exit(0).
- **`apps/studio/src-tauri/src/spawner.rs:102-106`** _[durability · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - Snap-backend prompt is string-interpolated into JSON, breaking on newlines/backslashes/quotes (request corruption / injection)
  - Impact: Any multi-line prompt, or a prompt containing a backslash, produces invalid JSON. curl POSTs a malformed body, the inference server returns a 400 / parse error, and the agent silently fails (output goes to stderr only). A backslash before a user quote (\\") also lets the user break out of the JSON string. Users cannot run normal multi-line prompts.
  - Fix: Build the request body with serde_json::json!({ "model": model, "messages": [{ "role": "user", "content": prompt }], "stream": false }).to_string() so escaping is correct for all inputs, instead of hand-rolling the JSON string.
- **`apps/studio/src-tauri/src/tray.rs:13`** _[durability · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - tray setup .unwrap() on default_window_icon() panics the whole app at startup if no icon is set
  - Impact: If the bundle is built/configured without a default window icon (or on a platform/build where it resolves to None), the app aborts at launch with a panic instead of degrading. The user gets a silent crash with no window and no error.
  - Fix: Match on the Option and skip the icon (or return a tauri::Error) instead of unwrap(): `if let Some(icon) = app.default_window_icon() { builder = builder.icon(icon.clone()); }` so a missing icon degrades to a tray without a custom icon rather than crashing.
- **`docs/API_REFERENCE.md:78-84`** _[durability · User-facing docs accuracy (cross-checked against code)]_
  - API_REFERENCE marks session.attach as Free tier, but it is license-gated in code
  - Impact: A Free-tier user (or anyone before activating a license) who tries to re-attach to a session per the API docs gets -32001 'License required', contradicting the documented Free tier.
  - Fix: Either add `session.attach` to EXEMPT_METHODS in license.ts (matching the documented Free tier and the rest of session.* management), or correct API_REFERENCE.md to mark session.attach as Pro. The exempt set already includes session.list/update/end, so attach being excluded looks like an oversight.
- **`docs/GETTING_STARTED.md:93-111`** _[durability · User-facing docs accuracy (cross-checked against code)]_
  - Getting Started never tells users to set REVDEV_LICENSE_PUBLIC_KEY, which the daemon requires to verify any license
  - Impact: A customer self-hosting the source-visible daemon sets only REVEALUI_LICENSE_KEY per Getting Started, and their valid license silently degrades to FREE because the public key is unset — with the cryptic stderr 'REVDEV_LICENSE_PUBLIC_KEY not set — cannot verify signature' buried in logs. The happy-path doc cannot produce a working Pro activation.
  - Fix: Add REVDEV_LICENSE_PUBLIC_KEY to the env-var table and to the License Activation steps, explaining where customers obtain the vendor public key. Cross-reference KEY_GENERATION.md step 2 which sets it.
- **`docs/TROUBLESHOOTING.md:101-103`** _[durability · User-facing docs accuracy (cross-checked against code)]_
  - Troubleshooting 'v1 license keys' section mislabels and misroutes legacy-key error
  - Impact: A user who hits the real error message and searches the troubleshooting doc for it finds nothing matching (wrong quoted string). They also won't realize an RVUI.v2.* key is equally rejected, since this section only mentions `RVUI-pro-...`.
  - Fix: Quote the actual stderr string ('Legacy license formats (RVUI.v2.*, RVUI-*) are no longer accepted'), state both RVUI- and RVUI.v2.* are rejected, and point users to `scripts/issue-license.ts` / the license API for a JWT.

### MEDIUM (71)

- **`apps/console/api/agents.go:157-178`** _[durability · Console Go TUI (payment/licensing/proxy)]_
  - ParseSSEEvents silently drops malformed events and read errors
  - Impact: Agent streaming output truncates or stops with no error reaching the caller — the operator sees the stream just freeze/end mid-task with no explanation, unable to tell success from failure.
  - Fix: Check scanner.Err() after the loop and emit a synthetic error event; raise the buffer with scanner.Buffer(); surface unmarshal failures as a diagnostic event rather than dropping them.
- **`apps/console/api/agents.go:125-153`** _[durability · Console Go TUI (payment/licensing/proxy)]_
  - StreamAgent leaks the response body on caller-side parse abandonment; no read timeout
  - Impact: Any agent task longer than 30 seconds has its SSE stream killed mid-flight; the operator sees the stream die at ~30s every time regardless of task state, with the read surfacing as a generic scanner end (swallowed per the previous finding).
  - Fix: Use a separate http.Client without a global Timeout for streaming, or set Transport-level timeouts (ResponseHeaderTimeout) instead of Client.Timeout for the streaming path.
- **`apps/console/proxy/proxy.go:141-167`** _[ux · Console Go TUI (payment/licensing/proxy)]_
  - pickSession reads one raw buffer with no line discipline; multi-char/paste input misparsed
  - Impact: Selecting any session index >= 10 (or any input where the terminal delivers keystrokes individually) fails: the user types '12<enter>' and gets 'invalid choice: 1'. Confusing dead-end with no second chance — the function returns an error and Handle aborts.
  - Fix: Read line-by-line with a bufio.Reader / accumulate bytes until newline, or switch to a proper Bubble Tea picker; re-prompt on invalid input instead of aborting the session.
- **`apps/console/tui/model.go:127-132, 199-206`** _[ux · Console Go TUI (payment/licensing/proxy)]_
  - Pricing fallback (mock) tiers shown as real with no indication, and checkout uses stale IDs
  - Impact: When /api/pricing is down, the user sees a fully normal-looking plan list with prices that may be out of date, picks one, and createCheckoutCmd posts the hardcoded tier ID. If the API is up but checkout uses a stale tier/price, they could be charged the wrong amount or hit a confusing checkout error with no hint the data was offline.
  - Fix: Track an `offline bool` set when pricing fetch fails, render a persistent '(offline pricing — may be out of date)' badge on ViewTiers, and disable/confirm checkout while offline.
- **`apps/console/tui/model.go:179-182`** _[ux · Console Go TUI (payment/licensing/proxy)]_
  - Checkout QR render failure is silently swallowed
  - Impact: If QR generation fails (e.g. URL too long for the chosen recovery level — go-qrcode returns an error past its capacity), the user just sees no QR with zero explanation, while the success text 'Checkout ready!' still shows. They may not notice the URL line and assume the flow is broken.
  - Fix: On render error set a soft notice ('QR unavailable — use the URL below') so the absence is explained, and ensure the raw URL is always prominent.
- **`packages/daemon/src/server.ts:566-592`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - session.register dual-write to Neon and identity bootstrap are awaited but the revvault persistence is fire-and-forget with void, and its rejection path can still produce an unhandled rejection if revvaultSet itself throws synchronously before the try
  - Impact: An unexpected throw inside the revvault write path becomes an unhandledRejection. Under default recent-Node policy that crashes the process, dropping every connected agent's session — all for a best-effort secret backup.
  - Fix: Attach `.catch((err) => log.warn('revvault identity persist failed', { agentId, error: String(err) }))` to the void-ed call, matching the prune/nonce timer pattern.
- **`packages/daemon/src/server.ts:722-741`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - mail.broadcast inserts one row per recipient in a serial await loop with no transaction and no bound on recipient count
  - Impact: A mid-loop failure delivers to a subset, and the caller is told it reached everyone. Coordination messages (e.g. 'stop, conflict detected') silently lost for later recipients while the sender believes success.
  - Fix: Wrap the inserts in a single transaction (or one multi-row INSERT ... SELECT from agent_sessions) so the broadcast is all-or-nothing, and report the actual committed count.
- **`packages/daemon/src/server.ts:404-412`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - verifyOrWarn nonce-replay INSERT swallows ALL errors as 'replay', so a transient DB error silently downgrades a legitimate signed request to unsigned
  - Impact: A transient PGlite error during nonce recording misclassifies a valid signed first-use request as a replay and silently demotes it to unsigned identity. Operators see 'nonce replay' warnings that are actually DB errors, masking the real fault.
  - Fix: Inspect the caught error; only treat unique-violation as replay. For any other error log distinctly (and consider rejecting rather than silently downgrading).
- **`packages/daemon/src/server.ts:344-412, 1367-1390`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - Identity/signature gate fails OPEN: every signature verification failure path in verifyOrWarn returns without rejecting, so a tampered or forged-but-unverifiable envelope is treated identically to no signature
  - Impact: A client supplying a deliberately bad signature plus a plaintext actorAgentId is authorized as that agent exactly as if it sent no signature — the signature layer provides zero enforcement, only telemetry. A presented-but-invalid signature being indistinguishable from no signature is a fail-open posture inconsistent with 'fail-closed where security demands'.
  - Fix: When `x-revdev-signature` is present but fails verification (vs absent), reject with an explicit error rather than falling through to the unauthenticated identity path; reserve fall-through for the no-signature case.
- **`packages/daemon/src/server.ts:1277, 1313, 1330, 1343, 1350, 1357, 1379, 1399, 1414, 1417`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - socket.write calls have no error handling or backpressure check; a write to a half-closed socket can throw or trigger an unhandled 'error' event
  - Impact: A client disconnecting mid-RPC (common for the Tauri bridge's fresh-per-call pattern) can cause a write to a destroyed socket. The synchronous throw escapes the async data handler as an unhandled rejection, which under default Node policy can crash the daemon. The empty error handler also makes real socket faults invisible in logs.
  - Fix: Guard writes with `if (!socket.destroyed && socket.writable)`, pass a callback that logs failures, and replace the empty `socket.on('error', () => {})` with a logging handler.
- **`packages/daemon/src/inference.ts:107, 136, 165, 193-198, 250-256`** _[durability · Daemon storage / migrations / dual-write / observability]_
  - Inference handlers cast params with `as` and never validate `model`/`messages`
  - Impact: Malformed RPC is forwarded to Ollama rather than rejected with an actionable error; caller gets an opaque Ollama 400/500 echoed back instead of 'missing required field: model'.
  - Fix: Guard at the top of each handler: reject when typeof model !== 'string' || !model, and for chat when !Array.isArray(messages), before any fetch.
- **`packages/daemon/src/neon.ts:81-112`** _[durability · Daemon storage / migrations / dual-write / observability]_
  - syncSessionRegister double-write is non-transactional and inflates total_sessions on every re-register
  - Impact: Per-agent total_sessions over-counts on every reconnect/daemon-restart/network blip even though it is the same session re-opening, so the admin fleet surface shows fabricated session volume.
  - Fix: Wrap both upserts in one Neon transaction; gate the +1 so it only fires for a genuinely new session (e.g. on ended_at IS NOT NULL OR NOT EXISTS), not every re-open.
- **`packages/daemon/src/neon.ts:113-115, 136-138, 163-165, 222-228`** _[durability · Daemon storage / migrations / dual-write / observability]_
  - Neon dual-write best-effort design loses coordination state with no replay or surfaced alert
  - Impact: During a Neon hiccup the cross-machine fleet view diverges from local truth and never reconciles; the only evidence is warn-level logs and there is no metric to alert on.
  - Fix: Increment a revdev_daemon_neon_sync_failures_total counter (observability.ts already exports Prometheus) in each catch, and persist a synced=false marker on the local PGlite row to enable the deferred replay.
- **`packages/bridge/src/client.ts:74-93`** _[durability · Protocol + bridge (RPC types, signing, DID, MCP/daemon client)]_
  - Per-call socket data handler re-splits and re-parses the entire accumulated buffer on every chunk
  - Impact: If the daemon emits a large or fragmented response, or a malformed stream that never produces a matching id, the bridge re-parses an ever-growing string and `buffer` grows unbounded until the 10s timeout — wasted CPU/memory per stalled call.
  - Fix: Track the trailing fragment: buffer = lines.pop() ?? '' and only iterate complete lines so each line is parsed once and consumed bytes are discarded.
- **`packages/bridge/src/index.ts:41-419, 382-401`** _[durability · Protocol + bridge (RPC types, signing, DID, MCP/daemon client)]_
  - MCP tool handlers have no per-call try/catch — every daemon failure surfaces as an unstructured MCP error, and daemon_status can throw after reporting healthy
  - Impact: Agents calling any of the ~25 tools get a raw thrown rejection (MCP isError) on transient daemon unavailability rather than a structured, retryable result; the health tool can hard-error in the exact race it was meant to handle gracefully.
  - Fix: Wrap each handler (or a shared daemon.call wrapper) in try/catch returning { isError: true, content: [{type:'text', text: actionable}] }; in daemon_status guard the harness.health call so a post-ping failure falls back to the 'Daemon is not running' message.
- **`packages/protocol/src/base58.ts:42-78`** _[durability · Protocol + bridge (RPC types, signing, DID, MCP/daemon client)]_
  - base58Decode runs unbounded O(n^2) BigInt math on caller-supplied strings with no length cap
  - Impact: Any path feeding a peer/attacker-controlled base58 string (public-key/fingerprint decode) into base58Decode can hang the event loop on a multi-kilobyte input — a cheap DoS/latency spike on daemon or bridge.
  - Fix: Reject s.length > 256 (ample for any Ed25519 key or fingerprint) at the top of base58Decode before the BigInt loop, throwing 'base58: input too long'.
- **`apps/studio/src/hooks/use-harness.ts:179, 182`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-harness: harness:state/harness:mail listener setup rejection is unhandled
  - Impact: If the Tauri event bridge fails to initialize, the harness dashboard silently never receives push updates (no state, no mail) and shows a stale 'connecting'/'disconnected' state with no error, because the failure is swallowed as an unhandled rejection rather than routed to `setError`.
  - Fix: Attach `.catch` to `setupListeners()` that calls `setError(...)` and `setStatus('error')`, and `.catch` the `loadAllRef.current()` call.
- **`apps/studio/src/hooks/use-harness.ts:209-259`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-harness: mutation helpers (sendMessage/markRead/createTask/claimTask/...) have no try/catch
  - Impact: If the daemon rejects a coordination mutation (e.g. claimTask on a task already claimed, or daemon down mid-call), the hook's `error` field stays null while the promise rejects to the calling component. Inconsistent with the read path, and components that don't individually try/catch these will throw/unhandled-reject, leaving the coordination UI in a silently wrong state.
  - Fix: Wrap each mutation in try/catch, set `error` on failure, and rethrow only if the caller needs it — or document that callers must handle.
- **`apps/studio/src/hooks/use-rvui-balance.ts:75-79`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-rvui-balance: unchecked array index and deep cast on Solana RPC response
  - Impact: A malformed or unexpected RPC response (different encoding, RPC node returning a non-Token-2022 account, API drift) throws inside the fetcher. usePollingFetch surfaces non-abort errors, so the balance tile shows an error every 60s, but the root cause (a TypeError/SyntaxError from BigInt) is opaque to the operator.
  - Fix: Validate the response shape before access: check `response.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount` is a string before constructing the BigInt, and throw a descriptive Error otherwise so the surfaced message is actionable.
- **`apps/studio/src/hooks/use-spawner.ts:47-51`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-spawner: agent_exit handler refreshes via floating agentList() with empty catch
  - Impact: When an agent process exits and the follow-up `agentList()` fails, the UI keeps showing the dead agent as 'running' with no indication anything went wrong. If the component unmounted between exit and resolution, `setSessions` runs on a torn-down tree.
  - Fix: Surface the refresh failure via `setError` instead of swallowing it, and guard the `.then(setSessions)` with the `cancelled` flag.
- **`apps/studio/src/components/apps/AppCard.tsx:47-49`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - External app 'Open' is fire-and-forget with no failure feedback
  - Impact: Clicking 'Open' on a running app can silently do nothing when the launch fails; the operator has no error and no indication why the browser didn't appear.
  - Fix: Await open(app.url) inside a try/catch and surface a toast/inline error on failure, e.g. 'Could not open localhost:<port>'.
- **`apps/studio/src/components/dashboard/Dashboard.tsx:72`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - RvuiBalanceCard 'Add wallet address' CTA is dead — prop never passed
  - Impact: When no wallet is configured the card shows 'No wallet configured' with no way to act on it — a dead-end. The user cannot reach the settings screen to add a wallet from this card as the code intends.
  - Fix: Pass an onNavigateToSettings callback from Dashboard (wired to the sidebar/router navigation to Settings) so the 'Add wallet address' button renders and works.
- **`apps/studio/src/components/dashboard/HealthCard.tsx:74-84`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - Status uses color-only indicators with no text/aria for screen readers
  - Impact: Color-blind users and screen-reader users cannot reliably distinguish healthy/degraded/error states where color is the primary differentiator; the daemon connection dot conveys nothing to a screen reader.
  - Fix: Add an icon/shape or text label alongside color for each status, and give status dots an accessible name (e.g. role="img" aria-label="Disconnected") rather than aria-hidden where they carry meaning.
- **`apps/studio/src/components/inference/InferencePanel.tsx:171-177`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - Snap Remove and Ollama model Delete are destructive with no confirmation
  - Impact: A single mis-click on 'Remove'/'Delete' uninstalls a local AI engine or deletes a downloaded model, forcing a slow re-download/re-install with no undo and no warning.
  - Fix: Add a confirmation step for removeSnap and deleteModel naming what will be deleted before invoking the destructive action.
- **`apps/studio/src/components/inference/InferencePanel.tsx:180-188`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - Snap install has no per-install progress; long operation looks frozen
  - Impact: During a multi-minute, multi-GB snap install the UI shows a frozen 'Installing…' label with no progress bar, byte count, or cancel. The operator cannot tell if it is progressing or hung, and cannot abort.
  - Fix: Stream install progress from the backend (percent or bytes) and render a progress indicator; provide a cancel affordance for the in-flight install.
- **`apps/studio/src/components/inference/InferencePanel.tsx:222-228`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - Ollama model pull has no progress and cannot be cancelled
  - Impact: Pulling a model gives a static 'Pulling…' button for minutes with no download progress and no way to cancel; the user cannot distinguish a slow pull from a stalled one.
  - Fix: Report pull progress (percent/bytes) from the daemon and render it; add a cancel button that aborts the pull.
- **`apps/studio/src/components/dashboard/DeployDashboard.tsx:59-74, 104-119`** _[ux · Studio deploy wizard (multi-step flow)]_
  - DeployDashboard has no empty/first-run state when no domain is configured
  - Impact: Before any deploy the Deploy Dashboard is a near-blank panel with a header and a Refresh button that does nothing (runHealthChecks returns early on empty list). Dead-end screen with no explanation or CTA.
  - Fix: Render a zero-state when services.length === 0 / no domain with a button to launch the wizard, and disable/hide Refresh.
- **`apps/studio/src/components/dashboard/DeployDashboard.tsx:124-147`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Service status colors are color-only with no text/aria, failing colorblind and screen-reader users
  - Impact: A screen-reader user gets an unlabeled decorative span for the dot; a colorblind user can't distinguish states by the dot. In StepDeploy the pushing-env/deploying/polling states are all yellow/orange and not distinguishable without reading the side label.
  - Fix: Give status dots role="img" + aria-label (or visually-hidden text) and ensure each status has a distinct text label.
- **`apps/studio/src/components/deploy/DeployWizard.tsx:47-53`** _[ux · Studio deploy wizard (multi-step flow)]_
  - No recovery/empty-state when config fails to load - wizard hangs on 'Loading...' forever
  - Impact: If get_config errors (backend not ready, IPC failure), the operator stares at 'Loading...' with no error message and no retry — a permanent dead-end that looks like a hang.
  - Fix: Consume error/loading from useConfig and render an error state with retry when config load fails.
- **`apps/studio/src/components/deploy/StepBlob.tsx:74, 84`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Successful steps lock all inputs with no edit/redo path (dead-end on mistakes)
  - Impact: If the operator pastes a wrong blob token / domain / Stripe key and clicks Save, the field locks with no in-step way to re-enable it. They are stuck with the wrong value unless they navigate away.
  - Fix: Add an 'Edit'/'Change' action that clears the saved/done flag and re-enables inputs.
- **`apps/studio/src/components/deploy/StepDeploy.tsx:229-247, 261-269`** _[ux · Studio deploy wizard (multi-step flow)]_
  - StepDeploy 'Retry Failed' re-deploys every app including ones already READY
  - Impact: Label promises a targeted retry but the action re-deploys already-successful apps, wasting time, creating duplicate Vercel deployments, and re-pushing env vars.
  - Fix: On 'Retry Failed', filter deployments to apps whose status is 'error' (or not 'ready').
- **`apps/studio/src/components/deploy/StepDomain.tsx:32-38, 40-41`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Domain input accepts any string with no validation; malformed domain propagates into env vars and DNS instructions
  - Impact: A typo like 'example .com' or 'http://example.com/path' produces plausible-looking but wrong derived URLs and DNS records baked into env vars and deployed. No inline validation; operator discovers broken CORS/URLs only after deploy.
  - Fix: Validate the domain (URL parser / hostname check) and show inline error before Save; reject paths/spaces/protocol-embedded input.
- **`apps/studio/src/components/deploy/StepSecrets.tsx:63-80, 90-108`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Generated secrets/keys are write-once with no copy or reveal, and cannot be regenerated
  - Impact: The operator can never see or back up the one-time encryption keys (REVEALUI_KEK protects encrypted data; losing it can make encrypted data unrecoverable). Combined with no persistence, if the deploy step doesn't fire the keys are lost with no copy and no regenerate.
  - Fix: Offer reveal + copy-to-clipboard per secret with a store-safely warning, and/or persist immediately; provide an explicit confirmed regenerate action.
- **`apps/studio/src/components/deploy/StepStripe.tsx:55-69`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Stripe seed output silently swallows parse failure, leaving price IDs / webhook secret empty with no operator notice
  - Impact: If the seed output isn't JSON, the operator sees green 'Stripe connected' while STRIPE_WEBHOOK_SECRET and all price IDs are silently empty. Deploy pushes empty NEXT_PUBLIC_STRIPE_*_PRICE_ID, producing a live site where checkout/pricing is broken with no warning.
  - Fix: If parsing fails or envVars are missing, surface a warning (not green 'connected') and provide manual-entry fields, or block Next until present.
- **`apps/studio/src/components/deploy/StepVercel.tsx:137-154`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Vercel step claims 'N projects linked' but always renders all 3 required projects as checked regardless of what actually linked
  - Impact: If linking/creating one project returns a falsy id, the checklist still shows all three green, telling the operator everything linked when it may not have. Count and checklist can disagree.
  - Fix: Render the check per project based on linkedProjects[req.key] truthiness, and reconcile the count with per-row state.
- **`apps/studio/src/components/deploy/StepVerify.tsx:89-98`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Health/verify HTTP errors are swallowed - non-2xx and request failures show the same opaque status with no actionable detail
  - Impact: When a check fails the operator gets a bare 'HTTP 502' or raw fetch error with no hint of what to fix and no way to re-run a single check — they must re-enter admin email/password and re-run all checks.
  - Fix: Map common failure codes to actionable hints and add per-check retry; remove the no-op identical ternary.
- **`apps/studio/src/App.tsx:142-147`** _[ux · Studio first-run / onboarding / shell]_
  - Modal close via backdrop/X equates to skipping setup (same as Skip)
  - Impact: An accidental backdrop/Escape dismissal silently ends onboarding forever, and if the updateConfig write rejects (the promise is void-ed) the modal closes anyway while config still says setupComplete=false — on next render the wizard reappears with no explanation, or the user is stuck depending on caching. Either way the dismissal outcome is non-deterministic and lossy.
  - Fix: Separate 'dismiss modal' from 'mark setup complete'; await/handle the updateConfig promise and keep the wizard open (with an error) if persistence fails.
- **`apps/studio/src/components/auth/LoginScreen.tsx:39-42`** _[ux · Studio first-run / onboarding / shell]_
  - OTP 'Resend code' and 'Use different email' give no confirmation or guard
  - Impact: A user who clicks 'Resend code' sees nothing change (the same 'We sent a 6-digit code to ...' text was already on screen), so they cannot tell whether a new code was actually sent, and can hammer the resend button into rate-limit errors.
  - Fix: Show an explicit 'New code sent' confirmation after a successful resend and apply a short cooldown (disable + countdown) on the Resend button.
- **`apps/studio/src/components/auth/LoginScreen.tsx:137-151`** _[ux · Studio first-run / onboarding / shell]_
  - 'Continue in local mode' is irreversible from the UI with no warning
  - Impact: A first-run user who taps 'Continue in local mode' to look around is locked into a degraded account-less mode with no obvious way back to the sign-in screen; the cockpit's account/API panels appear permanently broken to them.
  - Fix: Expose a persistent 'Sign in' / 'Exit local mode' affordance in the shell (e.g. StatusBar or Settings) that flips localMode back to false and returns to LoginScreen, and surface a clear 'Local mode — not signed in' banner.
- **`apps/studio/src/components/setup/SetupWizard.tsx:44-46`** _[ux · Studio first-run / onboarding / shell]_
  - SetupWizard 'Skip' permanently marks setup complete with no confirmation
  - Impact: A user who clicks Skip (or the modal's X/backdrop, which also fires onClose) intending to dismiss temporarily permanently flips out of first-run setup; the guided wizard never returns. They must rediscover the Setup page on their own.
  - Fix: Differentiate 'Skip for now' (close without persisting setupComplete) from 'Complete Setup' (persist), or confirm before marking complete. Don't bind the modal's dismiss (onClose/backdrop) to the same setupComplete write as an explicit completion.
- **`apps/studio/src/components/ui/StatusDot.tsx:39-50`** _[ux · Studio first-run / onboarding / shell]_
  - Status is conveyed by color alone across the shell and setup (StatusDot is aria-hidden)
  - Impact: Colorblind users and screen-reader users cannot perceive ready-vs-not-ready setup state from the dots; the dot itself is hidden from assistive tech, so the at-a-glance health indicators of the cockpit are invisible to AT.
  - Fix: Give StatusDot an accessible name (role=img + aria-label like 'ready'/'not ready', or a visually-hidden text twin), and add a non-color cue (icon/shape) for the OK vs off/error states.
- **`apps/studio/src/hooks/use-auth.ts:177-204`** _[durability · Studio first-run / onboarding / shell]_
  - Token refresh failure is fully swallowed — session silently dies
  - Impact: When a refresh fails (network blip, revoked device, server error), the operator gets no warning. They keep using a cockpit whose token will start 401-ing on every backend call, with no prompt to re-auth — every feature appears broken with no explanation of why.
  - Fix: On refresh failure within the expiry window, surface a non-blocking 'session expiring — please sign in again' notice and/or trigger recheck()/signOut() so the user is routed back to LoginScreen instead of operating with a dead token.
- **`apps/studio/src/hooks/use-auth.ts:151-157`** _[durability · Studio first-run / onboarding / shell]_
  - Offline access keeps a possibly-expired/revoked token treated as authenticated
  - Impact: If the API is down at launch, the user lands in the full cockpit as 'authenticated' even if their token was revoked or expired. Every account/API-backed action then fails individually with no coherent 'you are signed out' state — confusing partial-broken UI.
  - Fix: When falling back to offline access, decode the stored token's exp and reject if already expired; show a degraded 'offline — unverified session' indicator instead of presenting a clean authenticated state, and re-validate (recheck) as soon as the API is reachable.
- **`apps/studio/src/components/agent/AgentPanel.tsx:345-352`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - AgentPanel loadRemoteAgents has no error handling — a single API failure blanks the whole refresh
  - Impact: When the RevealUI API is down, the auto-refresh silently fails every 30s; remoteAgents may go stale or empty with no indication the cloud-agent list is broken, while workboard/git also stop refreshing on that tick.
  - Fix: Wrap loadRemoteAgents in try/catch (set a non-fatal error or empty list), and run the three loaders with Promise.allSettled so one failure doesn't abort the others.
- **`apps/studio/src/components/agent/AgentTerminalPane.tsx:32-39`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - AgentTerminalPane browser-mode and daemon-down states are shown only as dim terminal text
  - Impact: An operator cannot distinguish 'daemon is offline' from 'no agents running' — both render as the same empty list. In browser mode the terminal looks attached ('Attached to ...') but silently streams nothing, with the explanation buried as faint text.
  - Fix: Show a distinct 'Daemon unreachable — retry' banner when polling fails, separate from the zero-sessions empty state, and make the browser-mode notice a visible badge rather than dim terminal output.
- **`apps/studio/src/components/agent/SpawnerPanel.tsx:89-107`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Spawner Stop/Remove are unconfirmed and swallow errors
  - Impact: Clicking Stop kills a running local inference agent immediately with no confirm; if the stop/remove RPC fails the button appears to do nothing and the session lingers, with the only error surface being the panel-level `error` from the hook (not tied to the specific action).
  - Fix: Confirm before stopping a running agent, and ensure stop/remove failures surface a visible error rather than being voided.
- **`apps/studio/src/components/git/GitPanel.tsx:480-489`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - DiffView shows a git read error disguised as file content, not as an error
  - Impact: When a diff fails to load, the user sees a side-by-side diff claiming the file's new content is the literal text 'Error: <message>' added as a green insertion. This looks like a real (corrupt) diff rather than an error, and is easily mistaken for actual repo state.
  - Fix: Track a diffError state and render a proper error message in the right pane instead of stuffing the message into the diff's modified side.
- **`apps/studio/src/components/git/GitPanel.tsx:581-588`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Git push/pull errors auto-dismiss after 4 seconds, then disappear with no history
  - Impact: A push that fails (rejected, non-fast-forward, auth, network) flashes a truncated one-line error for 4 seconds and then vanishes. The operator may miss it entirely or be unable to read the full multi-line git error (e.g. 'Updates were rejected...'), and there is no log to scroll back to.
  - Fix: Keep remote errors visible until dismissed or the next action, and show the full message (not truncated) for failures — auto-dismiss is only appropriate for the success state.
- **`apps/studio/src/components/git/GitPanel.tsx:379-384`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Git default repo path is hardcoded to a personal absolute path and shipped as the first-run default
  - Impact: On first run every user's Git and Agent panels point at `~/projects/RevealUI`, which for most users (and this very repo) does not exist, so they are greeted with a git error ('not a repository' / path not found) instead of a clean empty/onboarding state.
  - Fix: Default to an empty repoPath that renders the existing 'No repository loaded' state and prompts the user to pick a repo, rather than a hardcoded path that will error for almost everyone.
- **`apps/studio/src/components/subscription/RvuiUpgradePanel.tsx:124-152`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - RvuiUpgradePanel manual tx-signature flow has no pending guidance and irreversible blind submit
  - Impact: The user is told to send 'the equivalent RVUI' to an unspecified wallet at an unspecified amount before pasting a signature. They have no way to know how much to send or where, making correct payment essentially impossible and overpayment/underpayment likely.
  - Fix: Show the platform wallet address (copyable), the exact RVUI amount to send, and the TWAP/price snapshot before the user pays, so the manual transfer is unambiguous.
- **`apps/studio/src/components/terminal/LocalTerminalPanel.tsx:24-27`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Local terminal shell exit is shown only as an ANSI banner with no restart prompt or recover affordance
  - Impact: When the default shell dies (e.g. wsl.exe not installed, shell crash), the user sees a faint colored line buried in scrollback and a dead terminal. The only recovery is the small 'Restart' button in the header, which is not connected to the failure message — many users will think the app is broken.
  - Fix: On exit, render a visible inline 'Shell exited — Restart' prompt/button in the terminal pane (not just an ANSI line), and consider surfacing the reason via ErrorAlert when the exit was an error.
- **`apps/studio/src/components/tunnel/TunnelPanel.tsx:49-56`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - TunnelPanel Connect/Disconnect have no per-action pending state — both buttons gray out together
  - Impact: When the user clicks Connect, the button just goes disabled with no spinner; tailscale up/down can take several seconds, so the user gets no progress feedback and may think the click did nothing or click repeatedly.
  - Fix: Add `loading={toggling}` to whichever action is in flight (or track which op is running) so the active button shows a spinner.
- **`apps/studio/src/components/vault/CreateSecretDialog.tsx:18-31`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - CreateSecretDialog value textarea has no inline validation feedback and is the only field that can silently no-op submit
  - Impact: A user who pastes whitespace or leaves the value blank and hits Enter gets no feedback at all — the dialog just sits there appearing broken.
  - Fix: Show a field-level validation message when path or value is empty after trim, instead of silently returning.
- **`apps/studio/src/hooks/use-sync.ts:41-67`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - SyncPanel: syncOne reuses the global `syncing` flag, disabling all repo buttons and clearing the whole log
  - Impact: Clicking 'Sync' on one repo greys out all other repos' buttons (looks like the whole panel froze) and erases prior sync log output. The user cannot tell which repo is actually syncing.
  - Fix: Track per-repo syncing state (e.g. a Set of repo names in flight) so only the active card shows a spinner and the others stay clickable, and append to the log instead of clearing it for single-repo syncs.
- **`apps/studio/src/lib/billing-api.ts:30-50`** _[durability · Studio transport / API client lib (invoke tri-mode, api wrappers)]_
  - Billing license/subscription fetches have no timeout — licensing checks can hang
  - Impact: fetchSubscription/fetchUsage gate tier+quota display. If the API stalls and the caller passes no signal (or one that never aborts), the request hangs and the subscription panel never resolves; the operator cannot see or refresh license/quota state.
  - Fix: Combine an internal AbortSignal.timeout(5_000) with the optional caller signal via AbortSignal.any (the exact pattern fetchHealth uses at health-api.ts:42-44) so authedGet always bounds its own wait.
- **`apps/studio/src/lib/invoke.ts:416-425`** _[durability · Studio transport / API client lib (invoke tri-mode, api wrappers)]_
  - pairWithDaemon has no timeout and re-parses JSON on the error path (double-throw)
  - Impact: Pairing against a slow/unreachable daemon hangs the pairing dialog. On a non-JSON error body (e.g. proxy 502 HTML), `await res.json()` throws SyntaxError, so the user sees 'Unexpected token' instead of the intended 'Pairing failed: 502' — that fallback string at line 423 is never reached.
  - Fix: Add `signal: AbortSignal.timeout(N)`; wrap the error-body parse in try/catch and fall back to `Pairing failed: ${res.status}` when the body is not JSON.
- **`apps/studio/src-tauri/src/commands/git.rs:504-515`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - git_discard_file / git checkout / git_write_file can be handed an absolute or ../-traversal file_path
  - Impact: A frontend bug or any future caller forwarding a path can read or overwrite files outside the repo; `git_write_file` with an absolute path silently clobbers an unrelated file with no error.
  - Fix: Canonicalize the joined path and verify it stays within the canonicalized repo_path; reject absolute or `..`-containing file_path before any fs op.
- **`apps/studio/src-tauri/src/commands/ssh.rs:36-47`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - ssh_disconnect drops the channel-reader task and SshSession without aborting the spawned task, leaking the task and channel
  - Impact: Each connect/disconnect cycle can leave a background task and channel alive briefly until russh observes the disconnect; many rapid reconnects could transiently accumulate tasks/sockets.
  - Fix: Store the `JoinHandle` in `SshSession` and `.abort()` it in `ssh_disconnect` after `handle.disconnect`. Also set the channel Option to None so the loop's `None => break` arm fires deterministically.
- **`apps/studio/src-tauri/src/commands/ssh.rs:147-153`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - SSH bookmark save is a non-atomic full-file truncate+write — crash mid-write loses all bookmarks
  - Impact: A crash while saving a bookmark can wipe the entire saved-connections list and corrupt the file so the SSH panel can no longer load or save bookmarks.
  - Fix: Write to a temp file in the same dir then `std::fs::rename` over the target (atomic replace on POSIX) so a crash leaves either the old or new complete file.
- **`apps/studio/src-tauri/src/inference.rs:115-136`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - ollama_pull / snap_install / ollama_list run blocking child processes with no timeout on the command thread
  - Impact: Pulling/installing a model freezes the calling command for minutes with zero progress; a stalled network or a wedged ollama/snap/which binary hangs the call indefinitely with no cancel.
  - Fix: Run downloads/installs as streaming spawned children emitting progress events (as spawner does) with a wall-clock timeout/cancel; wrap status probes (`which`, `ollama list`) in a bounded timeout so a hung binary cannot wedge the UI.
- **`apps/studio/src-tauri/src/local_shell.rs:139-170`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - Local shell PTY child is never killed when the reader thread detects exit, and dropping the session does not kill the child
  - Impact: A shell/agent process (including wsl.exe) can be orphaned after the pane closes via EOF-without-shell_close, or after a transient read error which is indistinguishable from real exit and silently tears down a live session leaving its child running.
  - Fix: Add `Drop for LocalShellSession` that kills+waits the child; in the reader thread after the loop call `child.kill()`/`wait()` before removing from the map; separate `Ok(0)` (EOF) from `Err(e)` so a transient error does not masquerade as exit.
- **`apps/studio/src-tauri/src/ssh.rs:215-228`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - TOFU known_hosts learn failure is swallowed; SSH connects anyway with an unrecorded host key
  - Impact: Future connections see the host as Unknown again (never matched), so the mismatch/MITM-detection path never fires for that host, while the UI falsely claims the key was saved — a fail-open in a security-sensitive path.
  - Fix: Propagate `learn_known_host` failure: fail the connection or set the event status to indicate the key could NOT be persisted so the user knows TOFU pinning is not in effect.
- **`apps/studio/src-tauri/src/ssh.rs:123-152`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - known_hosts check ignores hashed entries, defeating host-key verification for OpenSSH default configs
  - Impact: On OpenSSH default hashed known_hosts, Studio cannot detect a changed/spoofed host key (the MITM warning path is dead) and re-appends plaintext duplicate entries, silently weakening host-key security.
  - Fix: Support hashed entries (HMAC-SHA1 the host pattern with the decoded salt and compare, OpenSSH semantics). If hashed entries can't be evaluated, treat as 'cannot verify' rather than 'unknown -> trust'.
- **`apps/studio/src-tauri/src/config.rs:89-97`** _[durability · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - Config save is non-atomic (truncate-then-write) — crash mid-write corrupts config.json
  - Impact: If Studio crashes, the OS kills it, or power is lost between truncate and full write, config.json is left empty or truncated. On next launch load_config() fails to parse and silently falls back to StudioConfig::default() (ConfigState::new uses unwrap_or_default), so the user loses setup_complete, completed_steps, deploy/develop settings and is forced back through onboarding.
  - Fix: Write to a sibling temp file (config.json.tmp) in the same directory, fsync, then std::fs::rename over the target for an atomic replace. Optionally keep a .bak of the prior good file.
- **`apps/studio/src-tauri/src/daemon_ctl.rs:166-183`** _[durability · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - daemon_stop never escalates to SIGKILL — an unresponsive daemon can never be stopped from the UI
  - Impact: A daemon that ignores or is wedged on SIGTERM (e.g. stuck in a PGlite migration or blocked syscall) can never be killed via Studio. daemon_restart calls daemon_stop with `let _ =` (line 196) ignoring the failure, then daemon_start sees the still-alive PID and returns 'Daemon already running'. The user is permanently stuck — Stop says 'did not exit', Restart says 'already running', with no recovery path short of a manual kill -9 in a shell.
  - Fix: After the SIGTERM grace window expires, send libc::SIGKILL, wait briefly, remove the PID file, and only then report failure. Have daemon_restart surface stop failures (or force-kill) instead of swallowing them so restart can actually proceed.
- **`apps/studio/src-tauri/src/daemon_ctl.rs:110-145, 50-55, 96-102`** _[durability · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - daemon_start returns the spawned child PID, but stop/status trust the daemon's self-written PID file — PID mismatch breaks lifecycle if the daemon re-execs/forks
  - Impact: If the launched binary is a wrapper/launcher that forks the real daemon (or re-execs under a process manager), child.id() is a short-lived parent while the PID file holds the real daemon PID. daemon_start returns a PID the UI shows but daemon_stop ignores; or worse, the parent exits and is_pid_alive(child.id) is false while the daemon is actually up, causing the 'already running' guard and stop to act on the wrong process. Lifecycle controls become unreliable.
  - Fix: After the reachability loop succeeds, read the PID file and return THAT pid (the authoritative daemon PID), not child.id(). Verify the started child id matches the PID file or fail loudly if it diverges.
- **`apps/studio/src-tauri/src/daemon_ctl.rs:97-102`** _[durability · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - Stale PID file with a recycled PID makes daemon_start refuse to start the daemon
  - Impact: If the daemon dies uncleanly and leaves a stale PID file, and the OS later recycles that PID for an unrelated process, daemon_start aborts with 'Daemon already running (PID N)' even though the daemon is down and the socket is dead. The user cannot start the daemon and the whole harness (the 'brain') stays unavailable with a misleading error.
  - Fix: Gate the 'already running' decision on reachability too: only treat it as running if is_pid_alive(pid) AND a ping over the socket succeeds. Otherwise remove the stale PID file and proceed to spawn. (daemon_status already computes `reachable` separately — apply the same logic here.)
- **`apps/studio/src-tauri/src/state.rs:7`** _[durability · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - AppState platform Mutex uses .lock().map_err on a std::sync::Mutex that poisons permanently on any panic
  - Impact: Once any platform operation panics while holding the lock, every subsequent mount/unmount (and any other PlatformOps call) returns a poison error string forever, until the user restarts Studio. Platform features are silently bricked mid-session.
  - Fix: Recover from poisoning instead of propagating it: use lock().unwrap_or_else(|e| e.into_inner()) (the Box is still valid after a panic in these handlers), or switch to a parking_lot::Mutex which does not poison. Ensure the platform operations themselves don't panic while holding the guard.
- **`apps/studio/src-tauri/src/updater.rs:37-49`** _[ux · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - install_update calls updater.check() a second time and aborts if the update vanished between check and install
  - Impact: Double network round-trip on every install, and a race: if the release manifest changes (or a transient endpoint hiccup returns None/Err) between the user seeing 'Update available' and clicking Install, the install fails with 'No update available' or a network error even though an update existed. The user sees an update they cannot install.
  - Fix: Have check_for_update return/cache the Update handle (e.g. in managed state keyed by version) and have install_update consume that handle directly, falling back to a fresh check only if no cached handle exists. At minimum, treat Ok(None) on the install path as a benign 'already up to date' rather than an error after the user explicitly chose to install.
- **`README.md:40-47`** _[ux · User-facing docs accuracy (cross-checked against code)]_
  - README repository layout omits packages/bridge that Getting Started tells users to run
  - Impact: A user reading the README to understand the repo can't find the bridge package, then is told elsewhere to point their AI tool at packages/bridge/dist/index.js — confusion about whether that path is real, and no guidance that the bridge must be built first.
  - Fix: Add `packages/bridge/` to the README layout, and add a 'Build the bridge' step (e.g. `pnpm --filter @revdev/bridge build`) to the MCP section of GETTING_STARTED before referencing dist/index.js.
- **`docs/TROUBLESHOOTING.md:126-137`** _[durability · User-facing docs accuracy (cross-checked against code)]_
  - Database-reset troubleshooting moves the entire data dir including the license-key-file and socket, not just the database
  - Impact: An operator follows the reset, and if they kept a license key file or any sidecar under ~/.local/share/revealui, it is silently relocated to .bak; the daemon restarts FREE/degraded with no obvious link to the reset. The blast radius is wider than the 'loses session history' note implies.
  - Fix: Scope the reset to the PGlite database subpath rather than the whole dataDir, or expand the warning to enumerate everything under ~/.local/share/revealui (socket, pid, any license key file) and instruct users to preserve non-database files.

### LOW (60)

- **`apps/console/main.go:82-84, 91-93`** _[durability · Console Go TUI (payment/licensing/proxy)]_
  - Server uses log.Fatalf inside goroutine and on shutdown error — abrupt exit, no graceful drain
  - Impact: If ListenAndServe returns ErrServerClosed during the intended graceful shutdown, the goroutine log.Fatalf races the clean shutdown and the process exits with code 1, killing active SSH sessions without the 5s drain. Operators see a non-zero exit on a normal stop.
  - Fix: In the goroutine, ignore http.ErrServerClosed; on other errors signal the done channel instead of os.Exit. On Shutdown error, log and return non-fatally so deferred cleanup runs.
- **`apps/console/proxy/proxy.go:278-292`** _[durability · Console Go TUI (payment/licensing/proxy)]_
  - winCh resize forwarder goroutine leaks and writes to closed conn after detach
  - Impact: Goroutine leak per detached proxy session (winCh may not close promptly) and a possible 'use of closed connection' error logged on resize-during-teardown. Over many SSH sessions on a long-running server this accumulates.
  - Fix: Select on `<-done` and `win, ok := <-winCh` together so the goroutine exits on done; guard writes so none occur after teardown.
- **`apps/console/proxy/proxy.go:120, 127-130`** _[ux · Console Go TUI (payment/licensing/proxy)]_
  - Color-only status in session picker and bridge; no text fallback for status
  - Impact: On a monochrome/limited terminal or for a color-blind operator, the only distinction between session states is color, and non-running sessions disappear entirely with no 'paused/stopped' indication — the operator cannot tell a crashed session from one that never existed.
  - Fix: Render explicit status text per session (running/paused/exited) and list non-running ones dimmed-but-labeled instead of hiding them.
- **`apps/console/tui/model.go:293-296`** _[ux · Console Go TUI (payment/licensing/proxy)]_
  - Email validation accepts anything containing '@'; OTP screen shows raw email pre-trim
  - Impact: User mistypes an email, the client accepts it, sends to the API, and the failure (or a verification code sent nowhere) surfaces only as a raw HTTP-status error later. Avoidable round-trip and a confusing 'link returned 400' message.
  - Fix: Validate with a stricter check (non-empty local part, a dot-containing domain) and show inline feedback before submitting; the daemon should remain the authority but client-side feedback avoids the dead round-trip.
- **`apps/console/tui/model.go:255-257`** _[ux · Console Go TUI (payment/licensing/proxy)]_
  - Free tier 'enter' is a silent no-op with no feedback
  - Impact: A user selecting the Free plan presses Enter and the UI appears frozen/broken; they get no confirmation that Free needs no checkout, no guidance on how to actually start on Free.
  - Fix: Show an inline note ('Free plan — no checkout needed; just sign up at revealui.com') or a brief success/info line so the keypress visibly does something.
- **`apps/console/tui/model.go:535-536, 580-581`** _[ux · Console Go TUI (payment/licensing/proxy)]_
  - errMsg surfaces raw Go error strings (HTTP codes) to end users
  - Impact: Operators/customers see raw status codes and Go wrap-chains instead of actionable guidance. Unactionable and unprofessional on a paid-product checkout surface.
  - Fix: Map known failure classes (network down, 5xx, 4xx, conflict) to human messages with a next step; keep the raw error only in server logs.
- **`apps/console/tui/model.go:171-173, 199-206, 224-228`** _[ux · Console Go TUI (payment/licensing/proxy)]_
  - lookup failure clears nothing but the error toast disappears on next key; user never learns sign-in state failed
  - Impact: If the lookup API is briefly down, an already-linked paying user is shown as anonymous (no 'Signed in as', no current-tier badge) and prompted to link again, with the only hint being an error that vanishes on the first key they press.
  - Fix: Distinguish 'lookup failed' from 'not linked' state; keep a persistent inline notice for lookup failure and offer a retry rather than auto-clearing it.
- **`packages/daemon/src/cli.ts:143-164`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - Detached child daemon inherits parent license env but PID file is written only by foreground path; --detach orphans no PID file on early failure, but the deeper bug is missing close() on SIGKILL leaves stale socket
  - Impact: Operator runs `revdev-daemon --detach`, gets a success message and exit 0, but the daemon silently failed to start (port in use, expired license). Studio's supervisor then finds no listening socket and the user has no error to act on.
  - Fix: Have the parent wait briefly (poll the socket path / a readiness signal from the child via a pipe) before printing success, and propagate a non-zero exit + stderr message if the child exits before becoming ready.
- **`packages/daemon/src/cli.ts:207-220`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - PID file is written AFTER startDaemon resolves but is never removed on uncaught crash; SIGKILL or an unhandled exception leaves a stale PID file pointing at a dead process
  - Impact: After a hard crash the PID file persists with a stale PID. A supervisor/Studio reading it to decide 'is the daemon alive?' believes a daemon is running when it is not — or signals an unrelated process that reused the PID. Recovery requires manually deleting the file.
  - Fix: On startup, read any existing PID file and clear it if the process is dead (kill -0); add an uncaughtException/exit handler that unlinks the PID file.
- **`packages/daemon/src/server.ts:1277-1289`** _[ux · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - The overflow path writes to the socket and then immediately destroys it in the same tick; the queued write may be discarded, so the client never sees the -32700 error before the connection drops
  - Impact: A client that overruns the line-byte cap gets its connection dropped with no error frame delivered, so it sees a bare connection reset instead of the actionable 'frame exceeded N bytes' message — making the failure look like a daemon crash rather than a payload-size limit.
  - Fix: Use `socket.end(errorFrame)` (flush then close) instead of write()+destroy(), or pass a callback to write() that calls destroy() only after the frame is flushed.
- **`packages/daemon/src/server.ts:607-608`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - session.attach derives agentName from env.split(':')[1] with no guard; an env string lacking a colon yields undefined silently, and the row read uses a non-null assertion pattern
  - Impact: A session row with null/malformed env makes session.attach throw, returning -32000 'Internal error' instead of a clean attach. The agent cannot bind to its own session and is locked out of coordination RPCs.
  - Fix: Coalesce defensively: `const env = r.rows[0]?.env ?? ''; ctx.agentName = env.includes(':') ? env.split(':')[1] : null;`
- **`packages/daemon/src/server.ts:1178-1227, 1518-1533`** _[durability · Daemon core (JSON-RPC server, CLI, config, guard)]_
  - Nonce sweep, license recheck, and prune timers run db.query against a PGlite that close() may already be tearing down; only pruneTimer is conditionally created and the timers are cleared in close() but in-flight timer callbacks are not awaited
  - Impact: On shutdown an in-flight background sweep/prune/recheck query can throw 'database is closed' mid-query. It is caught by the timers' .catch(log.warn), so it doesn't crash, but it logs a spurious error on every coinciding shutdown and the sweep's work is silently lost — over time stale nonces/sessions accumulate if shutdowns repeatedly interrupt the sweep.
  - Fix: Track background-timer queries in the same drain accounting (increment/decrement _activeHandlerCount around them) or set a flag the timer callbacks check before issuing a query, so close() drains them or they no-op once closing has begun.
- **`packages/daemon/src/agent-identity-crypto.ts:35-42`** _[durability · Daemon identity / license / RPC validation]_
  - publicKeyRaw is sliced from a pooled ArrayBuffer using a fragile tail offset
  - Impact: Robustness gap: if Node's SPKI encoding length ever changed the slice would read 32 bytes from the wrong offset (silently producing a wrong fingerprint/DID) with no error. In practice the input is freshly generated by generateKeyPairSync('ed25519', spki) two lines above, so it is always the standard 44-byte SPKI and the slice is correct today; the key is not attacker-controlled.
  - Fix: Assert spkiDer.length is the expected Ed25519 SPKI length before slicing and derive via spkiDer.subarray(spkiDer.length - 32) (the final new Uint8Array copy at line 41 already detaches it from the pool). Throw on mismatch.
- **`packages/daemon/src/license.ts:183-243`** _[durability · Daemon identity / license / RPC validation]_
  - evaluateLicense() expiry status uses injected clock but verifyLicenseJWT validates expiry against the real clock
  - Impact: On a token whose exp/nbf falls between the two readings, the valid/expired verdict (real clock) and the warn-bucket/secondsRemaining (injected clock) can disagree (e.g. reported valid with negative secondsRemaining). In tests the injected clock has no effect on the actual temporal gate, so a green test can mask a real expiry-boundary bug.
  - Fix: Thread nowMs (or a now provider) into verifyLicenseJWT so a single clock drives both the expired/nbf checks and the warn bucketing.
- **`packages/daemon/src/validation/schemas.ts:58`** _[durability · Daemon identity / license / RPC validation]_
  - actorAgentId is unvalidated free-form string while agentId enforces DID grammar — inconsistent identity gate
  - Impact: An actorAgentId containing colons/slashes/spaces passes validation and becomes the acting identity, stored as agent_id in coordination rows (mail/files/tasks/memory/events). Identity attribution is therefore unconstrained on the actor field while constrained on the subject field — the asymmetry the agentId comment (schemas.ts:49-50) explicitly warns about, applied to the actor field instead.
  - Fix: Apply the shared isValidAgentId refine to actorAgentId everywhere it appears so the acting identity is DID-grammar-constrained before any handler uses it.
- **`packages/daemon/src/validation/schemas.ts:39-45`** _[durability · Daemon identity / license / RPC validation]_
  - safePath rejects '..' as a substring but allows symlinked/absolute escapes outside the blocked prefixes
  - Impact: files.reserve/check/release accept attacker-chosen absolute paths outside any project root (e.g. /home/<other>/.ssh/..., /var/..., /run/...) as reservation keys, so the coordination lock namespace can be polluted with arbitrary path strings. Note these handlers treat the path purely as a string key in the file_reservations table — they do NOT open/stat the file — so this is namespace pollution / weak allowlisting, not filesystem traversal or unauthorized file access.
  - Fix: Resolve against a configured project root and reject paths that escape it after normalization (path.resolve + prefix check, realpath where the file exists), rather than a '..' substring test plus three hardcoded prefix denials.
- **`packages/daemon/src/inference.ts:220-235, 279-294`** _[durability · Daemon storage / migrations / dual-write / observability]_
  - inference.chat/generate trust Ollama response shape; eval_count/eval_duration access unguarded
  - Impact: Callers receive { message: undefined, stats: { totalMs: NaN, ... } } as a 'successful' chat response — blank assistant output and NaN telemetry in the UI.
  - Fix: Validate the parsed shape (e.g. require typeof result.message?.content === 'string') and return an error otherwise; guard the duration math against undefined.
- **`packages/daemon/src/neon.ts:245-259`** _[durability · Daemon storage / migrations / dual-write / observability]_
  - syncMailBroadcast partial-commits then logs a single failure
  - Impact: Cross-machine fleet view shows an inconsistent broadcast: some agents see the mail and others never do, with no record of which were dropped.
  - Fix: Wrap the per-recipient INSERT loop in one Neon transaction so the mirror is all-or-nothing.
- **`packages/daemon/src/observability.ts:79-86`** _[durability · Daemon storage / migrations / dual-write / observability]_
  - PGlite health check reports a hardcoded duration of 0 and discards the real error
  - Impact: Operators cannot detect a slow/degrading DB from the health endpoint (duration meaningless), and on failure the report gives only a static string with no underlying cause (disk full, corruption, lock).
  - Fix: Measure with performance.now() around the query and report the real duration; in the catch capture err and include it in message (e.g. `PGlite query failed: ${String(err)}`).
- **`packages/daemon/src/vcs.ts:312-333`** _[durability · Daemon storage / migrations / dual-write / observability]_
  - merge.update builds dynamic SET with no parameterized whitelist and can issue an UPDATE that only touches updated_at
  - Impact: A no-op merge.update reports success and mutates updated_at, making the merge request appear to have progressed and misleading merge-train logic that keys off updated_at/status.
  - Fix: After building sets, if sets.length === 1 return { updated: false, error: 'merge.update: no fields to update' } without issuing the query.
- **`packages/bridge/src/client.ts:99-102`** _[durability · Protocol + bridge (RPC types, signing, DID, MCP/daemon client)]_
  - Daemon request timeout leaks the in-flight id and does not remove the socket data/error listeners
  - Impact: Under repeated daemon stalls the bridge process accumulates destroyed-socket closures and their growing `buffer` strings until GC; not a hard crash but a slow leak in a long-lived MCP server.
  - Fix: Wrap settle logic in a single `done` guard that calls socket.removeAllListeners() and socket.destroy() exactly once, and clear the timeout on success/error.
- **`packages/bridge/src/client.ts:59`** _[durability · Protocol + bridge (RPC types, signing, DID, MCP/daemon client)]_
  - Signature timestamp is generated client-side with no skew/validity window in the schema
  - Impact: A wrong host clock (suspended laptop, drifted VM) makes every signed RPC carry a ts the daemon's freshness/replay window rejects, manifesting as opaque 'Daemon error' rejections with no skew hint and no retry-with-resync.
  - Fix: Surface clock-skew as a distinct, actionable error (daemon returns a specific code; client maps it to 'agent clock is N seconds off, sync NTP') instead of a generic Daemon error.
- **`packages/protocol/src/did.ts:52-70`** _[durability · Protocol + bridge (RPC types, signing, DID, MCP/daemon client)]_
  - DID parse accepts an agentId containing characters never validated by isValidAgentId
  - Impact: resolveSigningConfig treats any non-null parseDid result as valid and sends the unvalidated fingerprint as kid (and the raw did string) in the envelope. Downstream daemon lookups keyed on agent_id/fingerprint can mismatch or silently fail auth, hard to diagnose.
  - Fix: After splitting, return null unless isValidAgentId(agentId) && isValidFingerprint(fingerprint), making parseDid symmetric with formatDid.
- **`apps/studio/src/hooks/use-settings.ts:99-112`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-settings: useSettings provider returns unstable updateSettings/resetSettings identities
  - Impact: Every provider re-render hands consumers a new context object, which can re-run the `fetchFn` useCallback in polling hooks and restart their poll loops more often than necessary (extra initial fetches / aborted in-flight calls). Causes avoidable RPC churn.
  - Fix: Wrap `updateSettings`/`resetSettings` in `useCallback` and the returned object in `useMemo` keyed on `[settings]`.
- **`apps/studio/src/hooks/use-tiles.ts:129-141`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - use-tiles: detectBrowserProfiles().then has no catch — unhandled rejection on mount
  - Impact: On a machine where browser-profile detection throws (permission error reading the user data dir, unexpected path), the failure surfaces as an unhandledrejection rather than degrading gracefully to 'no detected profiles'.
  - Fix: Add `.catch(() => { if (!cancelled) setDetectedProfiles([]); })` so detection failure falls back to the hardcoded default tiles.
- **`apps/studio/src/lib/health-api.ts:47-54`** _[durability · Studio React data hooks (fetch/poll/error/cleanup/races)]_
  - health-api: fetchHealth returns res.json() without checking res.ok
  - Impact: useHealth maps null to `reachable: false`, so an API that is reachable-but-unhealthy (the exact case the readiness probe exists to report) is displayed as 'unreachable' instead of 'unhealthy/degraded'. The operator gets a misleading health signal during partial outages.
  - Fix: Check `res.ok`; on a non-2xx with a parseable JSON body, return the parsed degraded/unhealthy payload rather than null, and only return null for true network/timeout failures.
- **`apps/studio/src/components/apps/AppsPanel.tsx:23-43`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - AppsPanel has no zero-apps empty state — blank screen after load
  - Impact: If the app list legitimately returns empty, the operator sees a bare header and empty space with no explanation ('No apps configured') and no guidance — a dead-end screen.
  - Fix: Add an explicit empty state for `apps.length === 0 && !loading` explaining there are no launchable apps and how to add/configure them.
- **`apps/studio/src/components/dashboard/HealthCard.tsx:75-84`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - HealthCard hides any non-healthy/degraded check status as red without showing the real value
  - Impact: Operators may interpret a benign 'unknown'/'starting' check as a critical red failure, prompting unnecessary remediation.
  - Fix: Map only known unhealthy statuses to red and use a neutral color for unrecognized/in-progress states.
- **`apps/studio/src/components/dashboard/TierBadge.tsx:6-18`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - TierBadge falls through to a generic style for real tier values, contradicting other tier labels
  - Impact: The tier shown at the top of the Dashboard (raw 'pro', neutral styling) visually disagrees with the SubscriptionCard tier pill ('Pro', orange), confusing the operator about their actual plan.
  - Fix: Use a shared tier label/color map (free/pro/max/enterprise) for both TierBadge and SubscriptionCard so the displayed tier is consistent and styled.
- **`apps/studio/src/components/devbox/DevBoxPanel.tsx:12-20`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - DevBox Mount/Unmount error is double-reported and log is wiped on each op
  - Impact: After a failed mount the operator loses the prior log history and sees the same error twice (banner + log line); refresh fires regardless of failure, which can mask the failure if status briefly looks ok.
  - Fix: Preserve prior log entries across operations (or append a separator), and skip refresh() when the mount/unmount reported an error; show the error in one place.
- **`apps/studio/src/components/devbox/MountLog.tsx:10-12`** _[durability · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - MountLog uses log line text as React key — duplicate lines collide
  - Impact: When two log lines are identical React drops/merges entries due to duplicate keys, so the operator sees fewer log lines than actually occurred — silently losing diagnostic output during a failed mount.
  - Fix: Key by array index (or attach a per-entry id/timestamp when entries are appended) instead of the raw line text.
- **`apps/studio/src/components/inference/InferencePanel.tsx:49-56`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - Inference Refresh button has no pending/disabled state
  - Impact: Operator clicks Refresh, nothing visibly changes, so they click repeatedly — firing concurrent ollamaStatus/snapList fetches with no feedback that a refresh is already running.
  - Fix: Disable the Refresh button and show a spinner/label while the inference snapshot is refreshing (consume the hook's loading state for an explicit pending indicator).
- **`apps/studio/src/components/infrastructure/DaemonPanel.tsx:20-34`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - DaemonPanel poll failures silently overwrite action errors and never recover the indicator
  - Impact: A transient action error can vanish within 10 seconds before the operator reads it; and when the socket is unreachable there is no diagnostic detail surfaced, only a bare 'Disconnected'.
  - Fix: Keep action errors separate from poll errors so a successful poll doesn't clear a user-triggered action error; render the daemon info block (with Socket: Unreachable) even when not reachable so the down state is explained.
- **`apps/studio/src/hooks/use-inference.ts:53-62`** _[ux · Studio dashboard + infrastructure + inference + devbox + apps panels]_
  - Inference startOllama uses a blind 2s delay then refresh — no readiness check
  - Impact: On slower machines, after clicking Start the panel can still show Ollama 'Stopped' even though it is starting, leading the operator to click Start again or assume it failed.
  - Fix: Poll ollamaStatus until running (with a timeout) instead of a fixed 2s sleep, and show a 'Starting…' state until confirmed running.
- **`apps/studio/src/components/deploy/StepDeploy.tsx:182-187`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Deploy 'Next' wipes per-app status if the user navigates back, and partial-success leaves stale ready URLs
  - Impact: After a partial deploy, going Back to fix something and returning shows all apps as 'Waiting' again, hiding which app succeeded/failed — the operator may redeploy the already-live app or lose the recorded deployment URL.
  - Fix: Lift per-app deploy status into persisted wizard/config state so it survives step remounts.
- **`apps/studio/src/components/deploy/StepVerify.tsx:42-51, 137-145`** _[ux · Studio deploy wizard (multi-step flow)]_
  - Admin password validated only for length 12 with no live feedback and lost on re-run
  - Impact: The operator only learns the 12-char rule after clicking Run Checks (which also triggers env-var pushes for the email-based checks). A single typo'd admin password becomes the permanent admin credential with no confirmation field.
  - Fix: Show the 12-char requirement inline as the operator types, add a confirm-password field, and validate before any side-effecting env pushes.
- **`apps/studio/src/components/setup/SetupRows.tsx:94-103`** _[ux · Studio first-run / onboarding / shell]_
  - DevPod row says 'install WSL from the Microsoft Store' / static labels but offers no recovery for a down dependency on several rows
  - Impact: When WSL or Tailscale is the blocking dependency, the user is told a problem exists but given no in-app path to fix or even re-check that specific row (the only recovery is the page-level Refresh on SetupPage; the SetupWizard modal has no per-row refresh). For WSL the instruction is also a dead text string, not a link/button.
  - Fix: Give the WSL and Tailscale rows actionable controls (open Store link / 'Start Tailscale' invoke) consistent with the Nix/DevPod rows, and ensure a re-check is reachable from the wizard, not only the full Setup page.
- **`apps/studio/src/components/setup/SetupRows.tsx:395-409`** _[ux · Studio first-run / onboarding / shell]_
  - InferenceSnaps install failure shows the message but leaves stale list; success of a partial install is ambiguous
  - Impact: After a failed install the AI Inference row can collapse to a misleading 'No inference snaps detected' empty state, hiding models the user just saw, with no indication the refresh itself errored.
  - Fix: Have refresh() surface its own failure (set error / keep prior models) instead of silently clearing to [], so a transient list-fetch error doesn't masquerade as 'nothing installed'.
- **`apps/studio/src/components/setup/SetupWizard.tsx:29-34`** _[ux · Studio first-run / onboarding / shell]_
  - 'Complete Setup' gate ignores rows the wizard actually presents
  - Impact: The user sees several setup rows sitting at a not-done (grey) state yet 'Complete Setup' is enabled — the completion criteria visibly disagree with the displayed checklist, making it unclear what is actually required vs optional.
  - Fix: Either visually mark the non-gating rows as 'Optional' so their grey dots aren't read as blocking, or include them in allDone. Make the gate and the checklist tell the same story.
- **`apps/studio/src/hooks/use-auth.ts:72-80`** _[durability · Studio first-run / onboarding / shell]_
  - Vault token sign-out cannot truly delete; stale empty token persists in vault
  - Impact: Operator-visible vault clutter: a permanent empty 'studio/device-token' secret remains after sign-out, and any code path that treats vaultGet's presence (rather than truthiness) as 'a token exists' would misbehave. The 'can't delete' limitation is a real durability gap, not a clean sign-out.
  - Fix: Add a vault delete/unset invoke command and call it in clearToken() so sign-out actually removes the secret rather than leaving an empty placeholder.
- **`apps/studio/src/components/agent/AgentTerminalPane.tsx:183-195`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - AgentTerminalPane stop control uses a bare glyph with no accessible label
  - Impact: Keyboard/screen-reader users get an unlabeled or oddly-announced control for a destructive action (stopping an agent session).
  - Fix: Add `aria-label="Stop session"` to the button and keep the glyph aria-hidden.
- **`apps/studio/src/components/agent/MessageInbox.tsx:91-105`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - MessageInbox 'To agent' select only lists live daemon sessions — cannot message offline/known agents and shows no empty-state guidance
  - Impact: When no peer agent is currently running, the user opens Compose, sees an empty recipient list, and cannot send — with no explanation that there is simply no one to message.
  - Fix: Show an inline note ('No active agents to message') when the recipient list is empty, and allow free-text recipient entry if messaging a known-but-inactive agent is valid.
- **`apps/studio/src/components/git/GitPanel.tsx:212-227`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - Commit message input does not enforce branch/commit conventions and offers no amend/recovery on failure
  - Impact: A commit rejected by a pre-commit hook shows a one-line tiny error that is easy to miss; the user may think the commit succeeded because the staged list refreshes.
  - Fix: Render commit errors in a more prominent, scrollable area (hook output can be multi-line) and keep the staged state/message intact so the user can fix and retry.
- **`apps/studio/src/components/sync/RepoCard.tsx:28-33`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - SyncPanel has no error/diverged guidance — destructive reset_failed/diverged states shown as a bare uppercase word
  - Impact: When a repo sync diverges or a reset fails (a potentially data-affecting condition since sync does hard resets per the status name), the user sees only 'DIVERGED' or 'RESET_FAILED' in orange/red with no detail or remediation path.
  - Fix: Map each non-ok status to a human-readable explanation and suggested action (e.g. 'Local commits diverged from remote — resolve manually'), and show it on the card or in the log.
- **`apps/studio/src/components/terminal/TerminalPanel.tsx:159-163`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - TerminalPanel SSH welcome banner copy is wrong once connected
  - Impact: On connect, the terminal greets the user with an instruction to use a form that has just been replaced by the terminal itself — contradictory and confusing.
  - Fix: Change the connected-state welcome to reflect the live session (e.g. 'Connected to <host>') or drop the connect instruction entirely.
- **`apps/studio/src/components/tunnel/TunnelPanel.tsx:113-117`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - PeerCard Copy IP swallows clipboard failures and shows false success
  - Impact: On a platform where clipboard write fails, the user clicks Copy IP and gets neither the 'Copied!' confirmation nor any error — the action appears dead.
  - Fix: Wrap navigator.clipboard.writeText in try/catch and show a failure indication, matching SecretDetail's pattern.
- **`apps/studio/src/components/vault/SecretDetail.tsx:18-27`** _[ux · Studio ops panels (vault, terminal, agent, git, tunnel, sync)]_
  - SecretDetail reveal/copy: copied secret stays in clipboard with no auto-clear and copy failure is silently swallowed
  - Impact: If copying a secret fails, the user sees no error and may paste stale/empty content elsewhere. On success, the plaintext secret lingers in the OS clipboard indefinitely.
  - Fix: Surface copy failures (toast/inline) instead of swallowing them, and consider clearing the clipboard after a timeout for secret values.
- **`apps/studio/src/lib/invoke.ts:431-457`** _[durability · Studio transport / API client lib (invoke tri-mode, api wrappers)]_
  - httpRpc ignores JSON-RPC id correlation — out-of-order responses are mismatched
  - Impact: Each call is its own HTTP request/response, so correctness holds today (finder acknowledges this). The transport returns whatever `result` comes back without verifying the id; if the gateway ever batches/multiplexes/caches, a wrong command's result could be surfaced with no detection. The id counter also grows unbounded over a long session.
  - Fix: Validate `body.id === sentId` before accepting result; throw a transport error on mismatch.
- **`apps/studio/src/lib/invoke.ts:455`** _[durability · Studio transport / API client lib (invoke tri-mode, api wrappers)]_
  - httpRpc treats any 2xx body as valid JSON without guarding res.json()
  - Impact: A daemon/proxy returning 200 with non-JSON makes the call reject with 'Unexpected token' instead of an actionable 'malformed daemon response', and the failure is hard to diagnose.
  - Fix: Wrap res.json() in httpRpc in try/catch and throw 'daemon returned non-JSON response (HTTP ${res.status})'.
- **`apps/studio/src/lib/invoke.ts:471-475`** _[ux · Studio transport / API client lib (invoke tri-mode, api wrappers)]_
  - harness_ping browser-mode path collapses all daemon errors to false, hiding auth failures
  - Impact: A 401/403 ('Authentication required — pair with daemon first', thrown at line 449) is swallowed and reported as plain 'daemon not reachable' (false). The operator may try to restart infra when the real fix is re-pairing an expired/missing token.
  - Fix: Let auth errors propagate (or map ping to a distinct 'unauthorized' state) so the UI can prompt re-pairing instead of conflating it with unreachable.
- **`apps/studio/src/lib/tiles.ts:364-378`** _[durability · Studio transport / API client lib (invoke tri-mode, api wrappers)]_
  - detectBrowserProfiles JSON.parses arbitrary on-disk Preferences with no size bound and an empty catch
  - Impact: The full Chrome/Edge Preferences file (often multi-MB) is cat'd into a JS string and JSON.parsed on the main thread for every profile of every browser. A large/pathological file blocks the UI during parse on launcher open. Empty catch is acceptable; the unbounded read is the latent stall.
  - Fix: Read only the needed field (jq -r '.profile.name' or bounded head -c) instead of cat-ing and parsing the entire Preferences file.
- **`apps/studio/src-tauri/src/commands/agent.rs:4-15`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - agent_read_workboard reads arbitrary filesystem paths with no containment
  - Impact: The command can read any file the Studio process can access (returned to the frontend) — broader than its stated purpose; a frontend bug passing a wrong path exposes unintended file contents.
  - Fix: Restrict to an allowed base directory and reject paths escaping it after canonicalization, or accept only a fixed filename relative to a known root.
- **`apps/studio/src-tauri/src/commands/git.rs:416`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - git_log slices short_sha with sha[..7] — panics if a commit id is shorter than 7 chars
  - Impact: Latent panic risk: an unexpected commit-id length aborts git_log via panic instead of a recoverable StudioError; the git panel shows a hard failure.
  - Fix: Use `sha.get(..7).unwrap_or(&sha).to_string()` or `sha.chars().take(7).collect()` so it can never panic.
- **`apps/studio/src-tauri/src/commands/vault.rs:39-49`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - vault_is_initialized uses a placeholder WINDOWS_USERNAME default of "user", masking an uninitialized vault
  - Impact: On a WSL setup without WINDOWS_USERNAME set, a vault under the real Windows user dir is reported not-initialized, nudging the user toward vault_init which could create a second divergent identity/recipients set.
  - Fix: Drop the `user` fallback; if WINDOWS_USERNAME is unset, skip that candidate or derive it by enumerating /mnt/c/Users so the check never probes a bogus path.
- **`apps/studio/src-tauri/src/inference.rs:168-183`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - ollama_stop uses pkill -f "ollama serve" — kills unrelated processes and the wrong server
  - Impact: Stopping Ollama from Studio can kill a user-started Ollama server (losing in-flight inference) or any unrelated process whose command line mentions the string, causing surprising loss.
  - Fix: Capture and store the Child from `ollama_start` and kill that specific PID; to stop an externally-started server, use Ollama's API/PID file rather than substring-matching the process table.
- **`apps/studio/src-tauri/src/local_shell.rs:106-134`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - Local-shell open() inserts session into map after spawning child but stores no kill-on-failure path for reader-thread spawn
  - Impact: A PTY reader/writer setup failure leaks the just-spawned shell process; the user sees an error but an orphan shell keeps running.
  - Fix: On the error paths after spawn_command, explicitly child.kill()+wait() before returning Err, or own the child in an RAII guard that kills on early return.
- **`apps/studio/src-tauri/src/platform/windows.rs:411-425`** _[durability · Tauri Rust IO (ssh, local_shell, inference, terminal/process commands, platform)]_
  - Windows start_app spawns wsl.exe and immediately drops the Child without reaping it
  - Impact: Repeatedly starting apps accumulates unreaped wsl.exe handles for Studio's lifetime — a minor handle leak; any failure after spawn is silently dropped.
  - Fix: Either spawn detached intentionally and document it, or spawn a short reaper thread that waits the wsl.exe wrapper; capture/report spawn failures.
- **`apps/studio/src-tauri/src/spawner.rs:162-176, 182-198`** _[ux · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - Agent stdout/stderr reader threads silently break on first non-UTF8 line, truncating live output
  - Impact: If an agent emits a single line of non-UTF8 bytes (binary, a stray control sequence, a truncated multibyte char), the reader thread exits permanently and the user stops seeing ALL further output from that agent's stdout (or stderr), even though the process keeps running and producing valid lines afterward. Appears as an agent that mysteriously goes silent.
  - Fix: Read raw bytes (read_until(b'\n')) and lossy-decode with String::from_utf8_lossy, or on Err log and `continue` instead of `break`, so a single bad line doesn't kill the whole output stream.
- **`apps/studio/src-tauri/src/spawner.rs:263-273`** _[ux · Tauri Rust backend core (lifecycle, daemon supervision, updater, state)]_
  - agent_list always reports pid: None, so a UI showing PIDs cannot identify or externally kill agents
  - Impact: The frontend agent list can never display a real PID. If the in-app stop path is wedged (see the Mutex deadlock finding), the user has no PID to fall back on for a manual kill, and any UI affordance bound to pid is permanently empty.
  - Fix: Populate pid: Some(proc.child.id()) in the list projection.
- **`docs/GETTING_STARTED.md:108-111`** _[ux · User-facing docs accuracy (cross-checked against code)]_
  - Getting Started claims daemon logs 'running with PRO license' via grep, but the line is prefixed and the grep pattern is fragile
  - Impact: A user greps and sees the FREE-mode line (also tagged [license]) and may misread it as success, or worries the bracketed `[license]` prefix doesn't match the documented 'Expected' string exactly. The verification step does not unambiguously confirm Pro activation.
  - Fix: Document the exact expected line including the prefix: `[license] RevDev daemon running with PRO license`, and tell users that `... running in FREE (degraded) mode` means activation failed.

