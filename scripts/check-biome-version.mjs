#!/usr/bin/env node
/**
 * Fail when the Biome that `pnpm exec biome` runs is not the exact version
 * pinned in the root package.json.
 *
 * The pin is an exact version, not a range. pnpm-lock.yaml records that same
 * version, and pnpm.overrides forces every copy in the tree to it. CI runs
 * this before `biome check`. A stale node_modules binary (the 2.5.0 vs 2.5.2
 * skew) exits 1 here instead of formatting differently from CI.
 *
 * Other fleet repos that run `biome check` in CI are out of scope. Note them
 * as a follow-up; do not widen this script.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function isRangeSpecifier(spec) {
  return (
    spec.includes('^') ||
    spec.includes('~') ||
    spec.includes('>') ||
    spec.includes('<') ||
    spec.includes(' ') ||
    spec.includes('||')
  );
}

export function parseBiomeVersionOutput(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const versionLine = lines.find((line) => line.startsWith('Version:')) ?? lines[0] ?? '';
  const parts = versionLine.split(' ');
  return parts[parts.length - 1] ?? '';
}

/** @returns {string | null} a loud error, or null when the three versions agree */
export function biomeVersionMismatch({ declared, installed, executed }) {
  if (typeof declared !== 'string' || declared.length === 0) {
    return 'root package.json devDependencies.@biomejs/biome is missing';
  }
  if (isRangeSpecifier(declared)) {
    return `root package.json pins a Biome range (${declared}); an exact version is required so local and CI cannot drift`;
  }
  if (installed !== declared) {
    return `installed @biomejs/biome@${installed} does not match the pin ${declared}. Run pnpm install --frozen-lockfile from the revdev root.`;
  }
  if (executed !== declared) {
    return `pnpm exec biome --version reported ${executed}, pin is ${declared}. A different Biome is on the path or node_modules is stale.`;
  }
  return null;
}

function readDeclared() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg.devDependencies?.['@biomejs/biome'];
}

function readInstalled() {
  const pkg = JSON.parse(
    readFileSync(join(root, 'node_modules', '@biomejs', 'biome', 'package.json'), 'utf8'),
  );
  return pkg.version;
}

function readExecuted() {
  const output = execFileSync('pnpm', ['exec', 'biome', '--version'], {
    cwd: root,
    encoding: 'utf8',
  });
  return parseBiomeVersionOutput(output);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const declared = readDeclared();
  let installed;
  let executed;
  try {
    installed = readInstalled();
    executed = readExecuted();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`biome version check could not read the installed CLI: ${message}`);
    process.exit(1);
  }
  const problem = biomeVersionMismatch({ declared, installed, executed });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`biome ${executed} matches the pin`);
}
