/**
 * Duplicate-work-claim check — a generic concurrency advisory.
 *
 * Generalizes the kind of collision the RevFleet duplicate-gap-claim detector
 * prevents (two concurrent sessions independently building the SAME unit of
 * work) into a configurable marker scan that carries NO project-specific
 * vocabulary. When the same claim identifier appears in 2+ git worktrees of a
 * project, that is the visible signal two sessions are building the same thing;
 * the signal is already in `git worktree list`, it just needs reading before a
 * second worktree is opened.
 *
 * A consuming project supplies its own claim markers (e.g. "TASK-", "GAP-",
 * "ISSUE-"). With no markers configured this check is a no-op, so the daemon
 * ships it provider-agnostic — nothing about any one tracker's id scheme is
 * baked in.
 *
 * Best-effort and read-only: any git error yields a clean (no-warning) result
 * and the check never throws. It reuses the daemon's hardened `runGit` helper
 * via a lazy import (a static import would form a load-time cycle: server.ts
 * imports the session-check registry before its own handler map initializes,
 * and vcs.ts registers handlers at module top-level).
 *
 * Zero authored regex — a substring scan plus a digit/letter walk extract each
 * claim identifier; `Map` / `Set` group them.
 */

import { basename } from 'node:path';
import type { ShellResult } from '../vcs.js';
import type { SessionCheck, SessionCheckResult } from './index.js';

export interface DupWorkClaimConfig {
  /**
   * Claim-marker prefixes to scan for, e.g. `["TASK-", "GAP-"]`. A claim
   * identifier is a marker followed by a run of alphanumeric characters
   * (`TASK-42` from a marker `TASK-`). Empty or unset makes the check a no-op.
   */
  claimMarkers?: string[];
}

/** One git worktree, as parsed from `git worktree list --porcelain`. */
interface WorktreeEntry {
  path: string;
  /** Branch name (after `refs/heads/`), or "" when bare/detached. */
  branch: string;
}

/**
 * Runs `git worktree list --porcelain` in `cwd`. Injectable so tests can supply
 * canned porcelain output or a forced failure without spawning git. The default
 * lazily imports `runGit` (see the module note on the load-time cycle).
 */
export type WorktreeLister = (cwd: string) => Promise<ShellResult>;

const defaultLister: WorktreeLister = async (cwd) => {
  const { runGit } = await import('../vcs.js');
  return runGit(['worktree', 'list', '--porcelain'], cwd);
};

/** True for an ASCII alphanumeric character. Zero regex. */
function isIdentChar(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * Extract claim identifiers from arbitrary text by each configured marker.
 * A match is the marker plus the following run of alphanumeric characters;
 * a bare marker with no trailing identifier is ignored. Case-insensitive, so
 * the returned ids are lowercased and collapse `.wt/TASK-42` with a branch
 * `task-42`. Substring scan + character walk, no regex.
 */
function extractClaims(text: string, markers: readonly string[]): Set<string> {
  const ids = new Set<string>();
  if (!text) return ids;
  const lower = text.toLowerCase();
  for (const marker of markers) {
    const m = marker.toLowerCase();
    if (m.length === 0) continue;
    let i = 0;
    while (i < lower.length) {
      const idx = lower.indexOf(m, i);
      if (idx === -1) break;
      let j = idx + m.length;
      let tail = '';
      while (j < lower.length) {
        const c = lower[j];
        if (c === undefined || !isIdentChar(c)) break;
        tail += c;
        j += 1;
      }
      if (tail.length > 0) ids.add(`${m}${tail}`);
      i = idx + m.length;
    }
  }
  return ids;
}

/** Parse `git worktree list --porcelain` into worktree entries. */
function parseWorktrees(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  const BRANCH_PREFIX = 'branch refs/heads/';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), branch: '' };
    } else if (line.startsWith(BRANCH_PREFIX) && current) {
      current.branch = line.slice(BRANCH_PREFIX.length).trim();
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Build a duplicate-work-claim advisory check bound to `config`. With no
 * markers configured the check always returns clean, so it is safe to register
 * by default on any project. `lister` is injectable for tests; production uses
 * the hardened `runGit`.
 */
export function createDupWorkClaimCheck(
  config: DupWorkClaimConfig,
  lister: WorktreeLister = defaultLister,
): SessionCheck {
  const markers = config.claimMarkers ?? [];
  return async (ctx): Promise<SessionCheckResult> => {
    const warnings: string[] = [];
    // Unconfigured (no markers) or no project root: nothing to inspect.
    if (markers.length === 0 || !ctx.workDir) return { ok: true, warnings };

    let result: ShellResult;
    try {
      result = await lister(ctx.workDir);
    } catch {
      // Any spawn failure is a clean no-op — this is an advisory, not a gate.
      return { ok: true, warnings };
    }
    if (!result.ok) return { ok: true, warnings };

    // claim identifier -> distinct worktree paths that claim it.
    const claims = new Map<string, Set<string>>();
    for (const wt of parseWorktrees(result.stdout)) {
      const ids = new Set<string>([
        ...extractClaims(basename(wt.path), markers),
        ...extractClaims(wt.branch, markers),
      ]);
      for (const id of ids) {
        let paths = claims.get(id);
        if (!paths) {
          paths = new Set();
          claims.set(id, paths);
        }
        paths.add(wt.path);
      }
    }

    for (const [id, paths] of claims) {
      if (paths.size >= 2) {
        warnings.push(
          `dup-work-claim: '${id}' is claimed by ${paths.size} worktrees (${[...paths].join(', ')}). ` +
            'Two sessions may be building the same thing; coordinate before continuing.',
        );
      }
    }

    return { ok: warnings.length === 0, warnings };
  };
}
