#!/usr/bin/env node
// Prove-red gate (verification-enforcement lane, spec 2026-07-10; language
// coverage extended per lane item 1d).
//
// A test that passes whether or not the fix is present proves nothing. This
// gate mechanises "prove red": on a PR that changes BOTH product source and
// test files, it reverts the source changes to the merge base, re-runs each
// CHANGED test, and REQUIRES at least one to be red against the base. A changed
// test that stays green without the source change is inert, and the gate
// blocks a PR whose only evidence is inert tests.
//
// The gate covers three toolchains. Each fires independently: a language is
// "active" only when the PR changes BOTH that language's source AND its tests,
// and each active language must produce >=1 red test of its own. Scope with
// PROVE_RED_LANGS (comma list of: typescript, go, rust); default is all three.
// CI runs one language per job so each job installs only the toolchain it needs.
//
// Coverage unit per language — stated honestly, because the granularity differs:
//   - TypeScript/vitest — the test FILE. Each changed `*.test.ts` runs via
//     `pnpm --filter <pkg> exec vitest run <file>` against reverted source.
//   - Go/`go test` — the PACKAGE. `go test` compiles and runs a whole package;
//     a single test FILE cannot be run in isolation (its funcs share the
//     package's other files). So a changed `*_test.go` is proven at package
//     granularity: the package, built from base non-test source plus the PR's
//     test files, must have >=1 failing test.
//   - Rust/`cargo test` — the integration-test FILE (`cargo test --test <name>`
//     per crate manifest). Inline `#[cfg(test)]` unit tests inside `src/*.rs`
//     are NOT covered: they compile together with the source they test, so
//     reverting the source removes the very tests, and proving them needs
//     per-hunk attribution. Same shape as the TS per-test deferral below.
//
// Honest limits shared by all three (kept in lockstep with the spec §4.2):
//   - It proves "the changed test does not PASS against base", which is weaker
//     than "fails on an assertion": a test that fails to compile/import because
//     it references a symbol the PR added counts as red here. So the gate kills
//     the worthless regression guard but does not certify test STRENGTH.
//   - Granularity is the unit above (file/package), not the individual test
//     case. A changed unit whose NEW test is inert but whose OLD test goes red
//     against base still passes. Raising this to per-test needs diff-hunk
//     attribution; deferred.
//
// Zero authored regex (fleet rule): path classification is suffix/substring
// membership only.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

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

// TypeScript / JavaScript ---------------------------------------------------
function tsIsTest(p) {
  if (p.includes('/__tests__/')) return true;
  for (const s of TEST_SUFFIXES) if (p.endsWith(s)) return true;
  return false;
}
function tsIsSource(p) {
  if (tsIsTest(p)) return false;
  if (p.endsWith('.d.ts')) return false;
  for (const s of CODE_SUFFIXES) if (p.endsWith(s)) return true;
  return false;
}

// Go ------------------------------------------------------------------------
function goIsTest(p) {
  return p.endsWith('_test.go');
}
function goIsSource(p) {
  return p.endsWith('.go') && !p.endsWith('_test.go');
}

// Rust — an integration test is a `.rs` whose parent directory is `tests`
// (`<crate>/tests/<name>.rs`), run per-file with `cargo test --test <name>`.
// Everything else under a crate (`src/**`) is source; inline `#[cfg(test)]`
// unit tests inside src are not separable (see header). The parent-dir check
// works whether the crate is the repo root (`tests/it.rs`) or nested
// (`apps/studio/src-tauri/tests/harness_integration.rs`).
function rustParentIsTests(p) {
  return basename(dirname(p)) === 'tests';
}
function rustIsTest(p) {
  return p.endsWith('.rs') && rustParentIsTests(p);
}
function rustIsSource(p) {
  return p.endsWith('.rs') && !rustParentIsTests(p);
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

// Restore each file to its base content (added-in-PR files are removed).
function revertToBase(files, base) {
  for (const { status, path } of files) {
    if (status === 'A') {
      execFileSync('rm', ['-f', path], { cwd: REPO_ROOT });
    } else {
      git(['checkout', base, '--', path]);
    }
  }
}

// --- manifest resolution ---------------------------------------------------

// Nearest ancestor dir (inclusive) containing `filename`.
function nearestDirWith(startDir, filename) {
  let dir = startDir;
  while (dir.startsWith(REPO_ROOT)) {
    if (existsSync(join(dir, filename))) return dir;
    if (dir === REPO_ROOT) break;
    dir = dirname(dir);
  }
  return null;
}

// Nearest package.json with a `name`, walking up from a file.
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

// --- command runner --------------------------------------------------------

function fail(msg) {
  console.error(`\n✗ prove-red: ${msg}`);
  process.exit(1);
}

function skip(msg) {
  console.log(`\n○ prove-red: ${msg}. Gate does not apply.`);
  process.exit(0);
}

// Run a test command; return its exit code (0 = green, non-zero = red). A
// missing toolchain is an ENVIRONMENT error, not a red — it must fail the gate
// loudly rather than be miscounted as failing-first evidence.
function runCmd(file, args, opts) {
  try {
    execFileSync(file, args, { stdio: 'inherit', ...opts });
    return 0;
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      fail(
        `toolchain '${file}' not found — cannot run \`${file} ${args.join(' ')}\`. ` +
          'Install it or scope the run with PROVE_RED_LANGS.',
      );
    }
    return typeof e.status === 'number' ? e.status : 1;
  }
}

// --- per-language run plans -------------------------------------------------
// Each plan turns changed test files into runnable "units" ({ label, exec }).

function planTypescript(tests) {
  const byPackage = new Map();
  for (const { path } of tests) {
    const abs = join(REPO_ROOT, path);
    const pkg = nearestPackage(abs);
    if (!pkg) {
      console.log(`prove-red: NOTE: no package.json owns ${path}; skipping it.`);
      continue;
    }
    if (!byPackage.has(pkg.name)) byPackage.set(pkg.name, { dir: pkg.dir, files: [] });
    byPackage.get(pkg.name).files.push(relative(pkg.dir, abs));
  }
  const units = [];
  for (const [name, { files }] of byPackage) {
    for (const file of files) {
      units.push({
        label: `${name} :: ${file}`,
        exec: () =>
          runCmd('pnpm', ['--filter', name, 'exec', 'vitest', 'run', '--no-coverage', file], {
            cwd: REPO_ROOT,
          }),
      });
    }
  }
  return units;
}

function planGo(tests) {
  // Group by owning module, then by package dir (relative to the module root).
  const byModule = new Map(); // moduleDir -> Set<relPkg>
  for (const { path } of tests) {
    const abs = join(REPO_ROOT, path);
    const moduleDir = nearestDirWith(dirname(abs), 'go.mod');
    if (!moduleDir) {
      console.log(`prove-red: NOTE: no go.mod owns ${path}; skipping it.`);
      continue;
    }
    const rel = relative(moduleDir, dirname(abs)) || '.';
    if (!byModule.has(moduleDir)) byModule.set(moduleDir, new Set());
    byModule.get(moduleDir).add(rel);
  }
  const units = [];
  for (const [moduleDir, pkgs] of byModule) {
    for (const rel of pkgs) {
      const target = rel === '.' ? './' : `./${rel}/`;
      units.push({
        label: `go ${relative(REPO_ROOT, moduleDir) || '.'} :: ${target}`,
        exec: () => runCmd('go', ['test', target], { cwd: moduleDir }),
      });
    }
  }
  return units;
}

function planRust(tests) {
  const units = [];
  for (const { path } of tests) {
    const abs = join(REPO_ROOT, path);
    const manifestDir = nearestDirWith(dirname(abs), 'Cargo.toml');
    if (!manifestDir) {
      console.log(`prove-red: NOTE: no Cargo.toml owns ${path}; skipping it.`);
      continue;
    }
    const stem = basename(path).slice(0, -'.rs'.length);
    const manifest = relative(REPO_ROOT, join(manifestDir, 'Cargo.toml'));
    units.push({
      label: `cargo ${manifest} :: --test ${stem}`,
      // --test-threads=1: the src-tauri integration tests route the harness
      // client through process-global env and race in parallel (mirrors
      // studio-rust-tests.yml). Harmless for the others.
      exec: () =>
        runCmd(
          'cargo',
          ['test', '--manifest-path', manifest, '--test', stem, '--', '--test-threads=1'],
          { cwd: REPO_ROOT },
        ),
    });
  }
  return units;
}

const LANGS = {
  typescript: {
    label: 'TypeScript/vitest (unit: test FILE)',
    isTest: tsIsTest,
    isSource: tsIsSource,
    plan: planTypescript,
  },
  go: {
    label: 'Go/go test (unit: PACKAGE)',
    isTest: goIsTest,
    isSource: goIsSource,
    plan: planGo,
  },
  rust: {
    label: 'Rust/cargo test (unit: integration-test FILE)',
    isTest: rustIsTest,
    isSource: rustIsSource,
    plan: planRust,
  },
};

// --- main ------------------------------------------------------------------

const baseRef = process.env.BASE_REF || process.env.BASE_SHA;
if (!baseRef) fail('BASE_REF is not set (pass the PR base sha).');

const ALL_LANGS = Object.keys(LANGS);
const requested = (process.env.PROVE_RED_LANGS || ALL_LANGS.join(','))
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
for (const id of requested) {
  if (!LANGS[id]) {
    fail(`unknown language '${id}' in PROVE_RED_LANGS (valid: ${ALL_LANGS.join(', ')})`);
  }
}

const base = mergeBase(baseRef);
console.log(`prove-red: merge base = ${base}`);
console.log(`prove-red: languages requested = ${requested.join(', ')}`);

const changed = changedFiles(base);

// A language is active only when the PR changes BOTH its source and its tests.
const active = [];
for (const id of requested) {
  const L = LANGS[id];
  const source = changed.filter((c) => L.isSource(c.path));
  const tests = changed.filter((c) => L.isTest(c.path) && c.status !== 'D');
  if (source.length > 0 && tests.length > 0) {
    active.push({ id, L, source, tests, units: L.plan(tests) });
  } else {
    console.log(
      `prove-red: ${id}: source=${source.length} test=${tests.length} — inactive, skipping`,
    );
  }
}

if (active.length === 0) {
  skip(`no requested language changed BOTH source and tests (requested: ${requested.join(', ')})`);
}

const totalUnits = active.reduce((n, a) => n + a.units.length, 0);
if (totalUnits === 0) skip('no runnable test units resolved from the changed test files');

// Revert every active language's source to base up front, then run each
// language's changed tests against it and require >=1 red per language.
for (const a of active) {
  console.log(`\nprove-red [${a.id}]: reverting ${a.source.length} source file(s) to base ${base}`);
  revertToBase(a.source, base);
}

let anyFail = false;
for (const a of active) {
  console.log(`\n=== prove-red [${a.id}] — ${a.L.label} ===`);
  if (a.units.length === 0) {
    // Activated but nothing runnable resolved (e.g. no owning manifest). Cannot
    // prove; report rather than silently pass.
    console.log(`prove-red [${a.id}]: no runnable test units resolved; no evidence produced.`);
    continue;
  }

  const redFiles = [];
  const greenFiles = [];
  for (const unit of a.units) {
    console.log(`\nprove-red [${a.id}]: running ${unit.label} against base`);
    const exit = unit.exec();
    if (exit === 0) {
      greenFiles.push(unit.label);
      console.log(
        `prove-red [${a.id}]: · ${unit.label} PASSED against base (compat update or inert)`,
      );
    } else {
      redFiles.push(unit.label);
      console.log(`prove-red [${a.id}]: ✓ ${unit.label} is red against base, proves the change`);
    }
  }

  if (greenFiles.length > 0) {
    console.log(
      `\nprove-red [${a.id}]: NOTE: these changed tests passed WITHOUT the source change:`,
    );
    for (const f of greenFiles) console.log(`    - ${f}`);
    console.log(
      '    They may be legitimate compatibility updates, or they may be inert.\n' +
        '    The gate does not block on them; a reviewer should confirm which they are.',
    );
  }

  if (redFiles.length === 0) {
    anyFail = true;
    console.error(
      `\n✗ prove-red [${a.id}]: NONE of the changed ${a.id} tests fail against the base. This PR\n` +
        `changes ${a.id} product source but carries no failing-first test that depends on the\n` +
        'change. Add a test that is red without the fix, or, for a genuine\n' +
        'behavior-preserving refactor, carry the recorded verify:no-behavior-change\n' +
        'label (applied by a non-author, per the verification-enforcement lane).',
    );
  } else {
    console.log(
      `\n✓ prove-red [${a.id}]: ${redFiles.length} changed test unit(s) red against base.`,
    );
  }
}

if (anyFail) process.exit(1);
console.log('\n✓ prove-red: all active languages carry failing-first evidence.');
process.exit(0);
