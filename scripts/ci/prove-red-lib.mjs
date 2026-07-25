#!/usr/bin/env node
// Pure predicates factored out of prove-red.mjs (GAP-393 review remediation,
// https://github.com/RevealUIStudio/revdev/pull/325#issuecomment-5080422951).
// Kept side-effect-free (no process.exit, no I/O) so they are importable and
// unit-testable without spawning the script or a git repo.

// Parses the PR_LABELS env var, which the workflows now transport as a JSON
// array (`toJSON(github.event.pull_request.labels.*.name)`), not a
// comma-joined string. The prior comma-joined transport was reviewed as
// lossy for a label name containing a comma; empirically (2026-07-25, `gh api
// repos/.../labels -f name="a,b"` against this repo) GitHub's REST API
// currently rejects a comma in a label name outright (422 Validation Failed,
// code "invalid") — the opposite of what the PR body under review claimed.
// Either way, JSON is the durable transport: it does not depend on an
// undocumented, unversioned GitHub validation rule to stay lossless.
// Malformed or absent input degrades to no labels; this never throws.
export function parseLabels(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((s) => String(s).trim()).filter(Boolean);
}

// Exact-element membership only: no substring, prefix, or case-insensitive
// match. A near-miss or differently-cased label name is not the exemption.
export function hasExemptLabel(labels, exemptLabel) {
  return labels.includes(exemptLabel);
}

// Fork-hardened promotion-skip predicate (GAP-393 review remediation).
// Mirrors the workflow-level `if:` one for one, and mirrors the shape of the
// org-shared `RevealUIStudio/.github/.github/actions/promotion-gate` composite
// (.github/workflows/promotion-gate.yml), which takes the same head_repo /
// base_repo inputs for the identical reason: `head_ref` alone is a bare
// branch name unqualified by repo, so a fork can name a branch "test" and
// open a PR to main, and the bare-branch-name check alone cannot tell it
// apart from a real promotion PR.
//
// Fails CLOSED: if the repo signal is not wired (headRepo/baseRepo missing —
// e.g. this runs outside the workflow, or a caller hasn't set
// PR_HEAD_REPO/PR_BASE_REPO), this returns false and the gate falls through
// to the normal prove-red path rather than silently skipping.
//
// Defense-in-depth, not the only wall: even without this predicate, a fork
// PR into main still fails the required `promotion-gate` check (a different
// workflow, `.github/workflows/promotion-gate.yml`) on the
// `head_repo != base_repo` branch, so it cannot merge either way. This
// predicate exists so THIS gate's own skip decision does not silently rest on
// an undocumented coupling to that other check ever staying required.
export function isForkSafePromotionSkip({ headRef, baseRef, headRepo, baseRepo }) {
  if (headRef !== 'test' || baseRef !== 'main') return false;
  if (!headRepo || !baseRepo) return false;
  return headRepo === baseRepo;
}

// True when a changed test file's nearest owning `package.json` is the repo
// ROOT one, not a workspace member's. `pnpm-workspace.yaml` scopes to
// `apps/*` and `packages/*`, so the root package (name "revdev") is not a
// pnpm workspace project.
export function isWorkspaceRootPackage(pkgDir, repoRoot) {
  return pkgDir === repoRoot;
}

// Resolves the command to run a changed TypeScript/vitest test file, given
// its owning package (GAP-393 review remediation,
// https://github.com/RevealUIStudio/revdev/pull/327#issuecomment-5080489570).
// A workspace-member package routes through `pnpm --filter <name>`. The
// workspace ROOT package does not: `pnpm --filter revdev exec vitest ...`
// matches no project, prints "No projects matched the filters", and EXITS 0
// — which the gate would otherwise silently score as a passing test that
// never ran. Route root-owned test files (e.g. scripts/**) through a
// root-level `pnpm exec` instead, which resolves via the root
// `vitest.config.mjs`.
export function typescriptRunArgs({ pkgDir, pkgName, repoRoot, relFile }) {
  if (isWorkspaceRootPackage(pkgDir, repoRoot)) {
    return { cmd: 'pnpm', args: ['exec', 'vitest', 'run', '--no-coverage', relFile] };
  }
  return {
    cmd: 'pnpm',
    args: ['--filter', pkgName, 'exec', 'vitest', 'run', '--no-coverage', relFile],
  };
}

// A command whose OUTPUT says it did no work must not be scored as green
// evidence. Mirrors runCmd's existing "a missing toolchain is an ENVIRONMENT
// error, not a red" rule one function up: the same worthless-evidence class,
// just the "ran nothing" shape instead of the "couldn't run at all" shape.
// Substring match only (zero authored regex, fleet rule).
const NO_WORK_DONE_MARKERS = ['No projects matched the filters'];
export function indicatesNoWorkDone(output) {
  if (!output) return false;
  return NO_WORK_DONE_MARKERS.some((marker) => output.includes(marker));
}
