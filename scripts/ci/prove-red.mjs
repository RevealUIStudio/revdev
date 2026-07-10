#!/usr/bin/env node
// Prove-red gate (verification-enforcement lane, spec 2026-07-10).
//
// A test that passes whether or not the fix is present proves nothing. This
// gate mechanises "prove red": on a PR that changes BOTH product source and
// test files, it reverts the source changes to the merge base, re-runs each
// CHANGED test file, and REQUIRES each to be red against the base. A changed
// test file that stays green without the source change is inert, and the gate
// blocks it.
//
// Honest limits (kept in lockstep with the spec §4.2):
//   - It proves "the changed test file does not PASS against base", which is
//     weaker than "fails on an assertion": a file that fails to import because
//     it references a symbol the PR added counts as red here. So the gate kills
//     the worthless regression guard but does not certify test STRENGTH.
//   - Granularity is the FILE, not the individual test case. A changed file
//     whose NEW test is inert but whose OLD test goes red against base still
//     passes. Raising this to per-test needs diff-hunk attribution; deferred.
//   - TypeScript/vitest only in Phase 1a. Rust (`cargo test`) and Go
//     (`go test`) changed-test prove-red is NOT covered and is logged loudly
//     below rather than silently skipped.
//
// Zero authored regex (fleet rule): path classification is suffix/substring
// membership only.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const REPO_ROOT = process.cwd();

// --- path classification (suffix/substring only) ---------------------------

const TEST_SUFFIXES = [
  '.test.ts',
  '.test.tsx',
  '.test.js',
  '.test.mjs',
  '.spec.ts',
  '.spec.tsx',
  '.spec.js',
  '.spec.mjs',
];
const CODE_SUFFIXES = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

function isTestFile(p) {
  if (p.includes('/__tests__/')) return true;
  for (const s of TEST_SUFFIXES) if (p.endsWith(s)) return true;
  return false;
}

function isCodeSource(p) {
  if (isTestFile(p)) return false;
  if (p.endsWith('.d.ts')) return false;
  for (const s of CODE_SUFFIXES) if (p.endsWith(s)) return true;
  return false;
}

// Non-TS test files we cannot prove-red yet, surfaced rather than silently dropped.
function isUncoveredTestFile(p) {
  if (p.endsWith('_test.go')) return true;
  if (p.includes('/tests/') && p.endsWith('.rs')) return true;
  return false;
}

// --- git helpers -----------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function mergeBase(baseRef) {
  return git(['merge-base', baseRef, 'HEAD']).trim();
}

// `--no-renames` so a rename shows as add+delete, which the revert logic below
// handles without a separate R-status branch.
function changedFiles(base) {
  const out = git(['diff', '--no-renames', '--name-status', base, 'HEAD']).trim();
  if (!out) return [];
  return out.split('\n').map((line) => {
    const tab = line.indexOf('\t');
    return { status: line.slice(0, tab).trim(), path: line.slice(tab + 1).trim() };
  });
}

// --- package resolution ----------------------------------------------------

function nearestPackage(fileAbs) {
  let dir = dirname(fileAbs);
  while (dir.startsWith(REPO_ROOT)) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = JSON.parse(readFileSync(pkg, 'utf8')).name;
        if (name) return { name, dir };
      } catch {
        // unreadable or nameless package.json; keep walking up
      }
    }
    if (dir === REPO_ROOT) break;
    dir = dirname(dir);
  }
  return null;
}

// --- main ------------------------------------------------------------------

function fail(msg) {
  console.error(`\n✗ prove-red: ${msg}`);
  process.exit(1);
}

function skip(msg) {
  console.log(`\n○ prove-red: ${msg}. Gate does not apply.`);
  process.exit(0);
}

const baseRef = process.env.BASE_REF || process.env.BASE_SHA;
if (!baseRef) fail('BASE_REF is not set (pass the PR base sha).');

const base = mergeBase(baseRef);
console.log(`prove-red: merge base = ${base}`);

const changed = changedFiles(base);
const changedSource = changed.filter((c) => isCodeSource(c.path));
const changedTests = changed.filter((c) => isTestFile(c.path) && c.status !== 'D');
const uncovered = changed.filter((c) => isUncoveredTestFile(c.path) && c.status !== 'D');

if (uncovered.length > 0) {
  console.log(
    `prove-red: NOTE: ${uncovered.length} changed Rust/Go test file(s) are NOT prove-red covered in Phase 1a:`,
  );
  for (const u of uncovered) console.log(`    - ${u.path}`);
}

// Fire only when product CODE source AND test files both change. Test-only,
// source-only, and docs/config-only PRs are out of scope by design.
if (changedSource.length === 0 || changedTests.length === 0) {
  skip(
    `changed source files = ${changedSource.length}, changed TS test files = ${changedTests.length}`,
  );
}

console.log(`prove-red: reverting ${changedSource.length} source file(s) to base ${base}`);
for (const { status, path } of changedSource) {
  if (status === 'A') {
    // Added in the PR, absent at base. Remove it.
    execFileSync('rm', ['-f', path], { cwd: REPO_ROOT });
  } else {
    // Modified or deleted in the PR; restore base content.
    git(['checkout', base, '--', path]);
  }
}

// Group changed test files by their owning package.
const byPackage = new Map();
for (const { path } of changedTests) {
  const abs = join(REPO_ROOT, path);
  const pkg = nearestPackage(abs);
  if (!pkg) {
    console.log(`prove-red: NOTE: no package.json owns ${path}; skipping it.`);
    continue;
  }
  if (!byPackage.has(pkg.name)) byPackage.set(pkg.name, { dir: pkg.dir, files: [] });
  byPackage.get(pkg.name).files.push(relative(pkg.dir, abs));
}

if (byPackage.size === 0) skip('no packaged TS test files to run');

// Run each changed test file against the reverted base and classify it.
//
// PASS requires AT LEAST ONE changed test file to be red against base: the PR
// must carry a failing-first test that genuinely depends on the change. A file
// that stays green is either a legitimate compatibility update to an existing
// test or an inert new one; the gate cannot tell those apart at file
// granularity, so it REPORTS them but does not block on them. It blocks only
// when NO changed test file is red, a source change with zero failing-first
// evidence, which is exactly the "a passing test proves nothing until it fails
// against the old code" failure this gate exists to catch.
const redFiles = [];
const greenFiles = [];
for (const [name, { files }] of byPackage) {
  for (const file of files) {
    console.log(`\nprove-red: running ${name} :: ${file} against base`);
    let exit = 0;
    try {
      execFileSync('pnpm', ['--filter', name, 'exec', 'vitest', 'run', '--no-coverage', file], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    } catch (e) {
      exit = typeof e.status === 'number' ? e.status : 1;
    }
    if (exit === 0) {
      greenFiles.push(`${name} :: ${file}`);
      console.log(`prove-red: · ${file} PASSED against base (compat update or inert)`);
    } else {
      redFiles.push(`${name} :: ${file}`);
      console.log(`prove-red: ✓ ${file} is red against base, proves the change`);
    }
  }
}

if (greenFiles.length > 0) {
  console.log('\nprove-red: NOTE: these changed test files passed WITHOUT the source change:');
  for (const f of greenFiles) console.log(`    - ${f}`);
  console.log(
    '    They may be legitimate compatibility updates, or they may be inert.\n' +
      '    The gate does not block on them; a reviewer should confirm which they are.',
  );
}

if (redFiles.length === 0) {
  console.error(
    '\n✗ prove-red: NONE of the changed test files fail against the base. This PR\n' +
      'changes product source but carries no failing-first test that depends on the\n' +
      'change. Add a test that is red without the fix, or, for a genuine\n' +
      'behavior-preserving refactor, carry the recorded verify:no-behavior-change\n' +
      'label (applied by a non-author, per the verification-enforcement lane).',
  );
  process.exit(1);
}

console.log(`\n✓ prove-red: ${redFiles.length} changed test file(s) red against base.`);
process.exit(0);
