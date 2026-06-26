# B6 Identity & Authorization — Design / Decision Record

**Status:** Accepted (owner-ruled 2026-06-25) — feeds the zero-9P agent-isolation ADR amendment and the Pro-GA gate.
**Basis:** 3-way code audit + senior-architect design pass (2026-06-25), both against worktree `revdev-b6-cont` (off `test`, includes #187). The lane plan §3 file:line table is **stale** (pre-#187) — this doc supersedes it for B6 touch-points.
**Scope:** Layer A (daemon RPC authorization + identity). Layer B (OS-level per-agent sandboxing) remains the durable wall, roadmapped separately.

---

## Owner-ruled durable decisions (2026-06-25)

The owner directed each decision toward the **long-term durable solution**, not the minimal-churn option:

### D1 — Identity (item 0): durable = self-certifying principal + alias layer
Authorization keys on a **self-certifying cryptographic principal** (derived from the key fingerprint) — intrinsic and unspoofable, never dependent on the correctness of a maintained anchor file. Human-readable coordination names (`conductor`, `agent-system`) become a **mutable alias → principal** mapping, claimed at enrollment with proof of key possession. The root-owned trust anchor degrades from *the* authorization root to **alias-claim policy**.

**Staging:** anchor + PoP rotation (D2) is cryptographically secure for the first sale; the only residual is a privileged provisioning typo binding a key to the wrong agentId. Therefore:
- **NOW (this slice):** keep the shipped anchor as the interim binding; harden the residual with an **anchor-lint** (single-source fingerprint computation at provisioning) + a **`harness.health` anchor-consistency assertion** (every `agent_identity` row's `(agent_id, fingerprint)` must be present in the loaded anchor; warn loudly otherwise).
- **NEXT LANE (durable target, recorded in the ADR):** self-certifying principal + alias indirection (DID-format change, alias table + migration). Removes the anchor-correctness trust assumption entirely.

### D2 — Headless/daemon-minted trust (item 8 boundary): durable = isolation rests only on client-owned per-request crypto
- **Filesystem-root ownership requires a client-owned, per-request-signed identity.** Daemon-minted (headless-hook) identities **may never own roots** and are **explicitly outside the Pro isolation guarantee**. Enforced via a `key_origin` column (`'client' | 'daemon'`); `project.open` rejects a root claim from a `daemon`-origin identity.
- Daemon-minted identities remain daemon-trusted for **coordination** methods (the daemon holds their key); because they cannot own roots, the socket-trust blast radius is coordination metadata only.
- **Durable endgame (recorded, not blocking):** per-request signing for headless coordination too (key pulled from revvault). Tolerated interim: socket-trust, *only* because it cannot touch file isolation.
- The ADR must state plainly: daemon-minted coordination rests on the `0600` socket + register binding, not per-request crypto — a weaker, free-tier boundary; the Pro-GA isolation claim scopes to client-owned identities.

### D3 — Root-ownership persistence (item 11): durable = persist + restore
`(dev,ino)`-keyed ownership + grants persisted in the daemon PGlite, **outside any registerable root and outside `file.*` reach**, `UNIQUE(dev,ino)`, restored on startup for still-active (not-ended) agents. The nested-root rejection runs against the restored set. No ephemeral wipe; no restart land-grab.

---

## Current model post-#187 (the real starting point)
Trust chain that already exists (do not re-build): (1) **enrollment binding** — a client key enters `agent_identity_keys` only if `"${agentId}:${fingerprint}"` is in the root-owned anchor (`registerClientIdentity`, `server.ts:758-817`; `readRootOwnedFile` O_NOFOLLOW, `server.ts:716-741`). (2) **verify-time binding** — a signature verifies only against `(fingerprint, agent_id, superseded_at IS NULL)` jointly (`server.ts:464-468`). (3) **authorization binding** — every `MUTATING_OR_CONTENT_METHODS` call is rejected unless `verified`; `ctx.agentId` is overwritten from the signer's DID at `server.ts:516` before the handler runs; `requireRoot(repoPath, ctx.agentId)` checks ownership (`filegit.ts:132-145`). Items 1/2/3/4/10 + the trust anchor all shipped in #187. The residual work is at the **edges**: rotation PoP, the unsigned coordination surface, persistence, inode keying.

---

## Action items (serialized — see sequencing rule)

| # | Action | Gate | Primary files |
|---|---|---|---|
| **A4** | `verifiedAgentId`/`requireVerifiedAgent` + 3 content leaks (`mail.inbox`, `memory.query`, `session.attach`) + from/owner-binding family (`mail.send`, `mail.markRead`, `tasks.claim/complete/release`) + enumeration-oracle family (`files.check`, `files.list`, `tasks.list` → caller-scoped) + grep CI test | Sonnet | `server.ts` (91,384,842,953,994,1073,1107,1148,1171,1201,1229,1333), `signing.rs:36`, `license.ts` (CI allowlist) |
| **A5** | `identity.rotate` PoP (signed by current key, `paramsHash` binds new key); delete rotation branch from `registerClientIdentity` | Sonnet | `server.ts` (149,758,795), `signing.rs:36` |
| **A6** | `RootEntry` shape + inode `(dev,ino)` key + atomic claim + persistence (D3) + eviction cascade + `key_origin` (D2: forbid daemon-minted root ownership) + anchor-lint/`harness.health` (D1 interim) | Sonnet | `filegit.ts` (47,53,140,391), `server.ts` (project.open path, prune/end), schema/migration |
| **A7** | `project.grant`/`project.revoke` keyed on **agentId**, owner-only, signature-required | Sonnet | `filegit.ts:140`, `server.ts`, `signing.rs:36` |
| **A8** | Adversarial CI suite (§6.a–k + 3-leak regression + PoP-rotation + exhaustive Rust↔TS drift 6.k) | Sonnet + Opus review | tests |
| **A9** | Refresh plan.md §3 (stale); mark items 0/0b/1/3/4/10 as #187-landed; record D1 next-lane target | mechanic | `plan.md` |
| **ADR** | Amend `2026-06-24-zero-9p-agent-isolation.md` §2/§2a + record D1/D2/D3 + the Layer-A-not-the-wall framing + daemon-minted-coordination disclosure | Opus | ADR |

### Hard sequencing rule
`server.ts` + `signing.rs` are edited by A4/A5/A7; `filegit.ts` by A6/A7. The pre-tool-use dirty-file hook blocks concurrent edits to the same file, and TS↔Rust lockstep pairs must land atomically. **Serialize A4 → A5 → A6 → A7, committing between each. A8 last (asserts the end state).** Do NOT fan these out in one worktree.

---

## A4 detail — verified-principal + leak sweep (the slice being implemented first)

**Core invariant.** Add a *derived* (never stored) verified principal: `verifiedAgentId(ctx) = (ctx.boundVia === 'signature') ? ctx.agentId : null`. It MUST be a per-request property derived from a per-request signature — never inherited from a connection-level bind (the existing pre-signature snapshot/restore at `server.ts:428-435,508-516` already makes a signature binding ephemeral to its request; ride that). `requireVerifiedAgent(ctx)` throws `-32003` when null. Self-scoped handlers call `requireVerifiedAgent`, never `requireAgent`.

**Banning rule (regression guard).** Any handler that (a) reads/writes root ownership, (b) returns root-scoped content/paths, or (c) reads/returns another principal's coordination data MUST resolve its principal via `requireVerifiedAgent(ctx)` and MUST NOT read `params.agentId`/`params.actorAgentId`/`params.owner` to choose *whose* data is touched — except on the addressing allowlist (`mail.send.to`, `tasks.create`, admin `*.list`). Back it with a **grep CI test** (analogue of the license.ts:78 no-wildcard test) that fails the build on: a non-allowlisted `params.agentId|actorAgentId|owner` self-scope use, OR a handler returning agent-scoped rows with no identity check.

**Per-method fixes** (promote each self-scoped method into BOTH `MUTATING_OR_CONTENT_METHODS` (`server.ts:149`) and Rust `requires_signature()` (`signing.rs:36`), lockstep + drift test):
- `mail.inbox` (`:953`): `agentId = requireVerifiedAgent(ctx)`; delete the `params.agentId` override.
- `memory.query` (`:1333`) + `memory.store` (`:~1324`): bind `agent_id = requireVerifiedAgent(ctx)`.
- `mail.markRead` (`:994`): bind reader = verified.
- `tasks.claim` (`:1171`) / `tasks.complete` (`:1201`) / `tasks.release` (`:1229`): bind owner = verified.
- `mail.send` (`:938`): `to` is addressing (OK); bind `from = verifiedAgentId`.
- `files.reserve` (`:1023`) / `files.release` (`:1085`): holder = verified.
- `session.attach` (`:842`): require an envelope **signed by the target agentId's current key** (`paramsHash` over `{sessionId}`); reject `-32003` otherwise. Crucially, after a signed attach, `boundVia` stays `'attach'`, **NOT** `'signature'` — so `verifiedAgentId(ctx)` is null on subsequent *unsigned* calls (attach must not grant a standing verified principal; self-scoped methods still require a per-request signature).
- Enumeration oracles — caller-scoped, not full lockdown: `files.check` (`:1073`) returns only the caller's reservations + a boolean "reserved-by-other" (no holder id, no reason); `files.list` (`:1107`) defaults to the verified caller's own reservations (cross-agent only behind `admin.*`); `tasks.list` (`:1148`) keeps the open/unclaimed pool global, but `owner`-filtered views require `owner === verifiedAgentId(ctx)` (or admin).

Headless-hook compat (D2): coordination methods becoming signature-required would break headless hooks that hold only daemon-minted keys — resolved by the `key_origin` model in A6 (daemon-minted identities are daemon-trusted for coordination). For A4, implement `verifiedAgentId` honoring a `key_origin='daemon'` register/attach-bound identity for coordination methods *only*; client-owned identities always require a per-request signature.

---

## Adversarial residual gaps (stated plainly, per the design)
1. **Anchor mis-provisioning** survives in the interim (D1 staging) — mitigated by anchor-lint + `harness.health`, eliminated by the staged self-certifying lane.
2. **Daemon-minted coordination** rests on the socket + register bind, not per-request crypto — free-tier boundary; disclosed in the ADR; cannot touch file isolation (D2 forbids root ownership).
3. **Layer A is the RPC chokepoint only** — moot against direct ext4 access (the daemon UID). Layer B is the durable wall; the SOC attestation must not overclaim Layer A.

---

## Progress log

### 2026-06-25 — A4 DONE + verified (commit `54dfaf9`; scaffolding `2b461c9`; design `82c343e`)
- **A4 (verified-principal coordination sweep)** shipped: `requireVerifiedAgent` replaces the spoofable `requireAgent`/`actorAgentId` fallback across all self-scoped coordination handlers. Closes the `mail.inbox` + `memory.query` content leaks and the `mail.send`/`tasks.*` sender-spoof family for client-owned identities; `files.check`→`reservedByOther`, `files.list`/`tasks.list` owner-filter caller-scoped (item 6). `key_origin` column (migration 0002) distinguishes client-owned (must sign) vs daemon-minted (socket-bound). Source-assertion CI guard `verified-principal-guard.test.ts`.
- **KEY DEVIATION from deliverable-3 — follow this for A5/A7 too:** coordination methods are NOT added to the dispatch signature gate (`MUTATING_OR_CONTENT_METHODS`) — that would force signatures and break daemon-minted headless hooks + every existing coordination test. The verified-principal check runs **in-handler** (`requireVerifiedAgent`), admitting either a per-request signature OR a daemon-minted bind (`key_origin` read authoritatively from `agent_identity`). TS↔Rust signed-set stays the file/git set (lockstep + drift test unchanged).
- **Follow-up flagged:** client-owned Studio must now SIGN its coordination calls (it can — `verifyOrWarn` honors a signature on any method). If Studio uses unsigned `actorAgentId` for coordination today, that's a required client-side change; record in the ADR.
- **Verified:** daemon typecheck clean; `migrate`+`verified-principal-guard` 24/24; integration suite 107/107. NOTE: the full daemon vitest run **flakes under parallelism** (24 daemons starting at once → startup timeouts). Run `vitest run --no-file-parallelism` (or per-file) to verify — every file passes in isolation.

### Remaining (serialized — A5 → A6 → A7 → A8; same-file collisions forbid parallelizing)
- **A5** — `identity.rotate` PoP (sign rotation with the current key, `paramsHash` binds the new key); add to `MUTATING_OR_CONTENT_METHODS` + Rust `requires_signature` (lockstep + drift test); **delete the rotation branch from `registerClientIdentity`** (server.ts ~lines 796-814, the `else if (existing.fingerprint !== fingerprint)` block). Reuse `requireVerifiedAgent` for the current-key check.
- **A6** — `RootEntry` redesign in `filegit.ts`: inode `(dev,ino)` key + atomic claim + persistence (D3: PGlite table, `UNIQUE(dev,ino)`, restore on startup, outside any registerable root) + eviction cascade (strip evicted agentId from other entries' grants too) + **forbid daemon-minted root ownership** (D2: `project.open` rejects when caller `key_origin='daemon'`) + the D1 interim anchor-lint/`harness.health` consistency assertion.
- **A7** — owner-only signed `project.grant`/`project.revoke`, keyed on **agentId** (not fingerprint); add both to `MUTATING_OR_CONTENT_METHODS` + Rust `requires_signature` (lockstep + drift test); `requireRoot` grants branch.
- **A8** — adversarial CI suite (§6.a–k + the 3-leak regression + PoP-rotation + exhaustive Rust↔TS drift).
- **A9 / ADR** — refresh lane `plan.md` §3 (stale); amend `docs/decisions/2026-06-24-zero-9p-agent-isolation.md` §2/§2a + record D1/D2/D3 + the daemon-minted-coordination disclosure + Studio coordination-signing follow-up.
