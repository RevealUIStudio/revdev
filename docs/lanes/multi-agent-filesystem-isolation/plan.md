---
lane: multi-agent-filesystem-isolation
repo: revdev
status: active
created: 2026-06-24
last-updated: 2026-06-25
revision: 2 (folded adversarial-critic findings, verified against code)
security-class: data-segregation / least-privilege
adr: revdev/docs/decisions/2026-06-24-zero-9p-agent-isolation.md
depends-on: zero-9P P0–P5 (#162/#164/#166/#167/#168/#169) — lands AFTER, does not block the train
blocks: Pro multi-agent tier GA (selling "run N agents concurrently")
tracking-issue: TBD
---

# Lane: Multi-Agent Filesystem Isolation (zero-9P)

## 1. Goal & two layers

Make each agent a distinct, **unspoofable** security principal in the daemon, so a subverted agent
cannot read/write/commit in repos it did not open, and cannot escalate to other agents' data.

- **Layer A (this lane):** identity-binding + per-agent authorization in the daemon — closes the RPC
  chokepoint now.
- **Layer B (out of scope, roadmap §10):** OS-level per-agent sandboxing (UID/namespace, bind-mounted
  roots) — the durable boundary against *direct* ext4 access and hardlink/inode aliasing; productized
  as the Pro guarantee.

> **Revision-2 headline:** an adversarial review (verified against code) found that v1 rested on a
> principal model the daemon does not provide — the "verified agentId" is a **self-asserted DID**, and
> `session.register` mints/rotates identities **unauthenticated**. Per-agent root scoping is meaningless
> until identity is bound (§5.0). v1's named-root authz items are necessary but were **not sufficient**.

## 2. Why (threat-model delta)

- The zero-9P ADR's threat model is **host-process-vs-WSL-daemon only**; it is **silent on
  agent-vs-agent** AND on **identity provisioning/rotation**. This lane extends the threat model →
  ADR amendment (§9), not just code.
- Realized threat: a trusted agent **subverted by the untrusted input it processes**, whose only fs
  reach is the daemon RPC. Plus: any host process that reaches the `0600` socket can impersonate an
  agent via the unauthenticated identity surface (§5.0).
- Multi-agent concurrency is the **Pro SKU** → cross-agent leakage is a shipped data-segregation
  defect; security docs are SOC attestations that must match enforcement.

## 3. Current state (grounded, file:line — verified)

| Fact | Location |
|------|----------|
| `agentId` is a **free, client-chosen** DID substring; `parseDid` only string-splits; `isValidAgentId` checks grammar only | `protocol/src/did.ts:52-69`, `:18-27` |
| `session.register` is **IDENTITY_EXEMPT** (no signature) and accepts arbitrary `agentId` + client `publicKeyPem` | `server.ts:108-110`, `:513-573` |
| `forceRotate`/key-supersede is **unauthenticated** — `SET superseded_at=NOW()` on the old key | `server.ts:528`, `:627`, `:684` |
| `requireRoot()`/`registeredRoots` is a **global** `Set<string>`, membership-only, not caller | `filegit.ts:42`, `:98-110`, `:206` |
| `project.open` is **signature-OPTIONAL**, registers globally, any local caller | `server.ts:1538-1554`; `filegit.ts:191-208` |
| `vcs.ts` `runGit` = bare `spawn(cmd,args)`, **no** `core.hooksPath`/config neutralization | `vcs.ts:89` |
| `within()` is descendant-only → **nested roots** (parent owner reaches child's files) | `filegit.ts:90-92`, `:136-147` |
| `actorAgentId` param is an **unauthenticated** identity fallback (`boundVia='param'`) | `server.ts:359-371`, `:1538-1542` |
| root registry is **in-memory**, non-persisted (wiped on restart) | `filegit.ts:42` |
| Verified-identity source (when a sig IS present) | `server.ts:439-443`, `:491` |

> Status note (2026-06-24): item **HG** (git hook/config neutralization, §5.8) shipped early on
> #162 — `runGit` now prepends `-c core.hooksPath=/dev/null -c protocol.ext.allow=never
> -c core.fsmonitor= -c core.sshCommand=false`. The remaining items below are unstarted.

## 4. Scope — the must-ship slice

> **Soundness rule:** every **MUST** is load-bearing — omit one and isolation is a *false sense of
> security*. Do **NOT** fold a partial into #162; ship the slice as a unit. Items **0/0b/3/HG** are the
> revision-2 additions without which v1 was theater.

| # | Item | Soundness | Cost | Status |
|---|------|-----------|------|--------|
| **0** | **Identity binding** — agentId unspoofable (self-certifying or daemon-minted) | **MUST (foundational)** | M | **DONE** (PR #187) |
| **0b** | **Authenticated registration/rotation** — rotate/supersede only via current key | **MUST (foundational)** | M | **DONE** (PR #187) |
| 1 | Per-agent root map keyed by verified agentId + `requireRoot(caller)` | **MUST** | M | **DONE** (PR #187) |
| 2 | `project.open` → signature-required, self-registers under caller only | **MUST (load-bearing)** | M | **DONE** (A6) |
| 3 | **Nested-root containment** — authorize against the most-specific owning root | **MUST** | M | **DONE** (PR #187, A4, A6) |
| 4 | Default-deny on unowned/unknown roots | **MUST** | S | **DONE** (PR #187) |
| 5 | Minimal signed, owner-only `project.grant`/`revoke` | **MUST (gate); rich stages** | M | **DONE** (A7) |
| 6 | Scope coordination methods returning content/root-paths (signed + caller-filtered) | **MUST** | M | **DONE** (A4) |
| 7 | Boundary **unconditional** — never Pro-gated | **MUST** | S | **DONE** (design; file isolation unconditional) |
| **HG** | **git hook/config neutralization** on all git handlers | **MUST (shipped on #162)** | S | **DONE** |
| 8 | **No `actorAgentId`** in any authz/root-scoped decision | **MUST** | S | **DONE** (A4) |
| 9 | Inode-aware canonical key `(dev,ino)`; atomic first-open claim | **MUST** | M | **DONE** (A6) |
| 10 | Ownership/grant **eviction** on agent end/prune; agentId not reusable | **MUST** | S | **DONE** (A6) |
| 11 | Persistence policy for the root map (or restart re-auth) | **MUST** | S | **DONE** (A6 D3) |
| 12 | Adversarial CI suite | **MUST** | M | **DONE** (A8) |
| 13 | ADR amendment | **MUST (doc — shipped: 2026-06-24-zero-9p-agent-isolation.md)** | S | **DONE** (ADR) |
| — | OS-level per-agent sandboxing; hardlink-file inode residue | out of scope — Layer B (§10) | L | deferred |
| — | **D1: self-certifying principal + alias layer** | next-lane target (recorded in ADR) | L | **NEXT LANE** |

## 5. Design

### 5.0 Identity binding (item 0) — foundational
`parseDid` (`did.ts:52`) yields a **client-chosen** agentId; the DB row (`server.ts:441`) is the only
binding and it was written at unauthenticated registration. **Fix:** make agentId **self-certifying** —
derive it from the public-key fingerprint (agentId == fingerprint, or a deterministic function of it),
so an agentId cannot be claimed independently of possession of its key. (Alternative: daemon **mints**
agentId and never honors a client-supplied agentId+key pair.) `requireRoot`/grants then key on an id
that is cryptographically the key holder.

### 5.0b Authenticated registration/rotation (item 0b)
`session.register` for a **new** id MAY be open only under §5.0 (self-certifying). For an **existing**
id, key rotation/supersede (`server.ts:627`, `:684`) MUST be **signed by the current, not-yet-superseded
key** (challenge/PoP). Remove the unauthenticated `forceRotate` supersede. Without this, §5.0 is undone
by a one-line takeover.

### 5.1 Per-agent root ownership (item 1)
Replace global `registeredRoots: Set<string>` (`filegit.ts:42`) with
`rootOwners: Map<canonicalKey, { ownerAgentId; grants: Map<agentId,'r'|'rw'> }>` where `ownerAgentId`
is the §5.0 verified principal (never a params field). `requireRoot(target, ctx, mode)` passes iff
owner==caller or active grant; else reject **`-32004`** (next-free; `-32001/2/3/99` taken).

### 5.2 `project.open` → signed + self-register (item 2, load-bearing)
Move `project.open` into `MUTATING_OR_CONTENT_METHODS` (`server.ts:146-167`) **and** the Rust
`requires_signature` set (`signing.rs:36-57`) in lockstep. Register under the verified caller; reject
unsigned (`-32003`). **First-opener-wins**, but see §5.9 (atomic, inode-keyed).

### 5.3 Nested-root containment (item 3)
`within()` is descendant-only (`filegit.ts:90`), so a parent-root owner reaches a child root's files.
**Fix:** `project.open` MUST reject a root that is an ancestor/descendant of a different agent's owned
root; and `resolveInRoot`/`requireRoot` MUST authorize the **target** against the **most-specific owning
root**, not the caller-named root.

### 5.4 Default-deny (item 4)
`requireRoot` default branch = reject; complements (not replaces) the existing realpath/traversal
allowlist (`filegit.ts:121-149`).

### 5.5 Grant/share (item 5)
This release: signed `project.grant(root, granteeAgentId, mode)` — **owner-only** — and
`project.revoke`; non-transitive; revocable; Studio brokers via the owner key. Fast-follow: UI, TTL,
sub-grants, audit log. Some grant path MUST ship same release or users disable isolation.

### 5.6 Scope coordination methods (item 6)
Audit `session.*`, `git.status`, `mail/tasks`, `files.*`, `memory.*`. Any returning content/root-paths
→ signature-required + filtered to caller's owned-or-granted roots. (Else B enumerates A via side channel.)

### 5.7 Unconditional, never Pro-gated (item 7)
Per-agent boundary always on (free + Pro). `EXEMPT_METHODS`/license gates Pro **coordination features**,
never the authz boundary (`license.ts:76-97` shows the file/git surface is license-exempt — isolation
MUST NOT ride that).

### 5.8 git hook/config neutralization (item HG)
`runGit` (`vcs.ts:89`) MUST neutralize repo-local escape hatches on every mutation/read:
`git -c core.hooksPath=/dev/null -c protocol.ext.allow=never -c core.fsmonitor= -c core.sshCommand=false
-c include.path= ...` (or run git under Layer B). Otherwise a hook/`.git/config` an agent writes into its
**own** root executes as the daemon UID → shared-UID RCE across all roots. Also neutralize submodule/
remote-driven config on `git.pull`. *(Shipped on #162: the four core flags; `include.path=` +
submodule/remote-driven-config hardening still to add here.)*

### 5.9 Inode-key + atomic claim (item 9)
Key `rootOwners` by `(dev,ino)` (`stat`), not realpath string — bind mounts/second mounts produce
distinct realpaths for the same inode. `project.open` claim MUST be **atomic** (unique constraint on
`(dev,ino)` INSERT-or-fail), not read-then-write (TOCTOU). Hardlinked-**file** residue is **only**
closable at Layer B — state that, don't claim it here.

### 5.10 No `actorAgentId` in authz (item 8)
Any method touching `rootOwners` or returning root-scoped content MUST use **only** `ctx.verifiedAgentId`
and ignore the `actorAgentId` param (`boundVia='param'`, `server.ts:359-371`) and the connection-level
`register`/`attach` identity — the `param` mode is inadmissible for authorization.

### 5.11 Eviction + persistence (items 10, 11)
Evict ownership/grants when a session ends/prunes (`server.ts:218-233`, `:780`); an agentId MUST NOT
inherit a terminated agent's roots without re-binding (§5.0). Define persistence: if persisted, the
store lives **outside any registerable root and outside `file.*` reach**, and restart **restores**
ownership (no first-opener land-grab); if not persisted, restart re-requires identity-authenticated
re-open and forbids a different agent claiming a previously-owned root within the DB lifetime.

## 6. Tests / CI (item 12 — MUST, fail build on regression)
- **a.** Agent B (valid sig) cannot touch A's owned root (all `file.*`+`git.*`).
- **b.** B cannot `session.register`/rotate identity for A's agentId; cannot sign as A. *(§5.0/0b)*
- **c.** `project.open` rejects unsigned (`-32003`); replay/stale-ts still rejected.
- **d.** B opening a path A owns does not grant B A's data; ancestor/descendant overlap rejected. *(§5.3/5.9)*
- **e.** `grant` enables, `revoke` disables, non-transitive.
- **f.** Coordination methods don't leak A's roots/content to B; `actorAgentId` inadmissible for authz. *(§5.6/5.10)*
- **g.** Boundary holds with **license OFF**. *(§5.7)*
- **h.** A git hook written into A's own root does **not** execute on `git.commit/push/pull`. *(§5.8)*
- **i.** Concurrent `project.open` of the same new root → exactly one owner. *(§5.9)*
- **j.** Restart restores ownership (or re-requires auth); terminated agentId doesn't inherit roots. *(§5.11)*
- **k.** Rust `requires_signature` ⊇ {`project.open`,`grant`,`revoke`} stays lockstep with TS. *(extend drift test)*

## 7. Sequencing & gating
- **Do NOT block the P0–P5 merge train.** It lands real durability/UX fixes + the host-process boundary.
- **GATE:** Pro multi-agent **GA** (selling "run N agents concurrently") blocked on this lane complete
  (all MUST + §6 green). Single-agent zero-9P ships freely meanwhile.

## 8. Execution order
1. ADR amendment (§9). 2. **Items 0 + 0b** (identity binding + authenticated registration) — *foundation; nothing else is sound first*. 3. Item HG (git neutralization) — cheap, closes the RCE. 4. Items 1+3+4+9 (per-agent map, nested-root, default-deny, inode/atomic). 5. Item 2 (signed `project.open`, TS+Rust lockstep). 6. Item 8 (`actorAgentId` ban). 7. Item 5 (grant/revoke). 8. Item 6 (coordination scoping). 9. Items 10+11 (eviction/persistence). 10. Item 7 + flip unconditional. 11. Record the §7 Pro-GA gate.

## 9. ADR amendment (item 13)
Amend the zero-9P ADR to add **agent-vs-agent** + **identity provisioning/rotation** as explicit trust
boundaries, the per-agent authz model, and the two-layer posture. Required so SOC attestations match.
Landed as `docs/decisions/2026-06-24-zero-9p-agent-isolation.md`.

## 10. Out of scope (Layer B — roadmap, not deferred indefinitely)
OS-level per-agent sandboxing (UID/namespace/container, only the agent's roots bind-mounted). The durable
boundary vs direct ext4 access **and** hardlink-file inode aliasing (§5.9 residue). Productized Pro guarantee.

## 11. Definition of done
All §4 MUST implemented; §6 suite green; identity self-certifying + rotation authenticated;
`project.open` signed TS+Rust lockstep; git handlers hook-neutralized; boundary proven unconditional;
nested-root + inode-key + atomic claim enforced; eviction/persistence specified+tested; minimal
grant/revoke shipped; ADR amended; Pro-GA gate recorded.

## 12. Risks
- **Biggest:** shipping the named-root authz without §5.0/0b → authorizes a spoofed principal (false
  security). Mitigation: items 0/0b first + tests 6.a/6.b.
- git-hook RCE (§5.8) silently makes confinement moot — must land in the same slice. *(core flags
  shipped on #162.)*
- Breaking multi-repo workflows → users disable isolation. Mitigation: minimal grant same release.
- Rust/TS signed-set drift. Mitigation: lockstep + test 6.k.
