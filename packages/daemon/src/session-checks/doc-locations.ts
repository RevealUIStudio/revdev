/**
 * Canonical doc-locations check — a generic structural advisory.
 *
 * Generalizes the kind of check the RevFleet `doc-locations-check.ts` scanner
 * performs (misplaced docs in a restricted directory, a required index file
 * missing from each of a directory's subdirectories) into a configurable rule
 * set that carries NO project-specific paths. A consuming project supplies its
 * own canonical-path rules; with an empty config this check is a no-op, so the
 * daemon ships it provider-agnostic.
 *
 * It only reads the immediate children of the configured directories (no
 * recursion, no traversal), reports warnings, and never mutates anything.
 *
 * Zero authored regex — path joins + `Set` / array membership only.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionCheck, SessionCheckResult } from './index.js';

/**
 * A directory whose direct children are restricted to an allowlist. Any file or
 * subdirectory not on the allowlist is flagged as misplaced.
 */
export interface RestrictedDirRule {
  /** Directory relative to the project root, e.g. "docs/handoffs". */
  dir: string;
  /** Filenames permitted directly in `dir`. All other files are flagged. */
  allowedFiles?: string[];
  /** Subdirectory names permitted in `dir`. All other subdirectories are flagged. */
  allowedSubdirs?: string[];
  /** Optional human-facing hint appended to each warning for this rule. */
  hint?: string;
}

/**
 * A directory each of whose immediate subdirectories must contain a required
 * file (e.g. every `docs/lanes/<slug>/` must have a `plan.md`).
 */
export interface RequiredFileRule {
  /** Parent directory relative to the project root, e.g. "docs/lanes". */
  parentDir: string;
  /** The file each immediate subdirectory must contain, e.g. "plan.md". */
  requiredFile: string;
  /** Subdirectory names to skip (e.g. meta directories). */
  ignoreSubdirs?: string[];
  /** Optional human-facing hint appended to each warning for this rule. */
  hint?: string;
}

export interface DocLocationsConfig {
  /** Directories whose direct children are restricted to an allowlist. */
  restrictedDirs?: RestrictedDirRule[];
  /** Directory groups whose subdirectories must each contain a required file. */
  requiredFileInSubdirs?: RequiredFileRule[];
}

/** Append a hint to a warning line when the rule carries one. */
function withHint(message: string, hint: string | undefined): string {
  return hint ? `${message} (${hint})` : message;
}

/** Read a directory's entries, treating an absent/unreadable dir as empty. */
async function readEntries(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    // Absent or unreadable directory: nothing to inspect, not a violation.
    return [];
  }
}

async function checkRestrictedDir(
  root: string,
  rule: RestrictedDirRule,
  warnings: string[],
): Promise<void> {
  const allowedFiles = new Set(rule.allowedFiles ?? []);
  const allowedSubdirs = new Set(rule.allowedSubdirs ?? []);
  const dirPath = join(root, rule.dir);
  for (const entry of await readEntries(dirPath)) {
    if (entry.isDirectory()) {
      if (!allowedSubdirs.has(entry.name)) {
        warnings.push(
          withHint(
            `doc-locations: unexpected subdirectory '${rule.dir}/${entry.name}/'`,
            rule.hint,
          ),
        );
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (!allowedFiles.has(entry.name)) {
      warnings.push(
        withHint(`doc-locations: unexpected file '${rule.dir}/${entry.name}'`, rule.hint),
      );
    }
  }
}

async function checkRequiredFileInSubdirs(
  root: string,
  rule: RequiredFileRule,
  warnings: string[],
): Promise<void> {
  const ignore = new Set(rule.ignoreSubdirs ?? []);
  const parentPath = join(root, rule.parentDir);
  for (const entry of await readEntries(parentPath)) {
    if (!entry.isDirectory()) continue;
    if (ignore.has(entry.name)) continue;
    const children = await readEntries(join(parentPath, entry.name));
    const hasRequired = children.some(
      (child) => child.isFile() && child.name === rule.requiredFile,
    );
    if (!hasRequired) {
      warnings.push(
        withHint(
          `doc-locations: '${rule.parentDir}/${entry.name}' is missing required file '${rule.requiredFile}'`,
          rule.hint,
        ),
      );
    }
  }
}

/**
 * Build a doc-locations advisory check bound to `config`. An empty config
 * produces a check that always returns clean, so it is safe to register by
 * default on any project.
 */
export function createDocLocationsCheck(config: DocLocationsConfig): SessionCheck {
  return async (ctx): Promise<SessionCheckResult> => {
    const warnings: string[] = [];
    // No project root means nothing to inspect.
    if (!ctx.workDir) return { ok: true, warnings };

    for (const rule of config.restrictedDirs ?? []) {
      await checkRestrictedDir(ctx.workDir, rule, warnings);
    }
    for (const rule of config.requiredFileInSubdirs ?? []) {
      await checkRequiredFileInSubdirs(ctx.workDir, rule, warnings);
    }

    return { ok: warnings.length === 0, warnings };
  };
}
