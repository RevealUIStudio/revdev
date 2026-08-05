/**
 * Repo-declared tooling detection (GAP-309).
 *
 * Walks up from a target path (never outside the registered project root) to
 * find the nearest directory that declares a formatter:
 *   - biome.json / biome.jsonc → Biome
 *   - Cargo.toml → cargo fmt / rustfmt
 *
 * No hardcoded repo path allow-list. Repos with neither marker are a no-op for
 * format enforcement. Shared so temp-artifact lifecycle (GAP-295) and other
 * "repo declares its own tooling" callers can reuse the same detection.
 */

import { access, constants as fsConstants } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export type DeclaredFormatter = 'biome' | 'cargo';

export interface ToolingRoot {
  /** Absolute directory holding the config file. */
  root: string;
  formatter: DeclaredFormatter;
  /** Absolute path of the config that declared the formatter. */
  configPath: string;
}

/** Max walk-up depth inside a registered root (guards pathological trees). */
const MAX_WALK_DEPTH = 40;

function withinRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the formatter declared for `absFile` inside `repoReal`.
 * Prefers the nearest config walking from the file's directory up to
 * (and including) the registered root. When both biome and cargo configs
 * exist at the same directory, both are considered by the caller via
 * extension matching — this returns biome first (JS/TS monorepos that also
 * have incidental Cargo.toml are rare; dual-config at one level is rarer).
 */
export async function detectDeclaredFormatter(
  repoReal: string,
  absFile: string,
): Promise<ToolingRoot | null> {
  let dir = dirname(absFile);
  if (!withinRoot(repoReal, dir) && dir !== repoReal) {
    dir = repoReal;
  }

  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (!withinRoot(repoReal, dir) && dir !== repoReal) {
      return null;
    }

    const biomeJson = join(dir, 'biome.json');
    const biomeJsonc = join(dir, 'biome.jsonc');
    if (await pathExists(biomeJson)) {
      return { root: dir, formatter: 'biome', configPath: biomeJson };
    }
    if (await pathExists(biomeJsonc)) {
      return { root: dir, formatter: 'biome', configPath: biomeJsonc };
    }

    const cargoToml = join(dir, 'Cargo.toml');
    if (await pathExists(cargoToml)) {
      return { root: dir, formatter: 'cargo', configPath: cargoToml };
    }

    if (dir === repoReal) {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

/**
 * Resolve an executable under node_modules/.bin walking from `start` up to
 * `repoReal` (inclusive). Used to find the repo's own biome without depending
 * on a global install or a hardcoded monorepo path.
 */
export async function resolveLocalBin(
  start: string,
  repoReal: string,
  binName: string,
): Promise<string | null> {
  let dir = start;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (!withinRoot(repoReal, dir) && dir !== repoReal) {
      break;
    }
    const candidate = join(dir, 'node_modules', '.bin', binName);
    if (await pathExists(candidate)) {
      return candidate;
    }
    if (dir === repoReal) {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/** Repo-relative path for diagnostics / fix commands (forward slashes). */
export function repoRelativePath(repoReal: string, absFile: string): string {
  const rel = relative(repoReal, absFile);
  return rel.split(sep).join('/');
}

/**
 * Paths that must never run through format enforcement (generated / vendor).
 * Checked against a forward-slash normalized absolute path.
 */
export function isFormatExemptPath(absPathNorm: string): boolean {
  const segments = absPathNorm.split('/');
  const exempt = new Set([
    'node_modules',
    'dist',
    '.turbo',
    'opensrc',
    'target',
    '.git',
    'coverage',
    '.next',
  ]);
  for (const seg of segments) {
    if (exempt.has(seg)) return true;
  }
  return false;
}
