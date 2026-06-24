#!/usr/bin/env node
// Zero-9P regression fence (ADR 2026-06-23, P5).
//
// Fails the build if Studio's file/git command modules reintroduce direct ext4
// or git access. Every file/git operation MUST route through the WSL daemon via
// `harness::repo_rpc` — that is what makes the 9P boundary gone *by
// construction* rather than guarded by review convention.
//
// Literal substring checks only (no regex). The needles are chosen to match
// real code, not prose: `git2::` carries the path separator so a comment that
// merely mentions "git2 behavior" does not trip it.

import { readFileSync } from 'node:fs';

const FILES = [
  'apps/studio/src-tauri/src/commands/git.rs',
  'apps/studio/src-tauri/src/commands/agent.rs',
];

const FORBIDDEN = [
  ['std::fs::', 'direct filesystem access — route through harness::repo_rpc file.*'],
  ['git2::', 'in-process libgit2 — route through harness::repo_rpc git.*'],
  ['Command::new', 'spawning a subprocess (e.g. git) — route through harness::repo_rpc'],
  ['process::Command', 'spawning a subprocess (e.g. git) — route through harness::repo_rpc'],
];

let violations = 0;

for (const file of FILES) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`fence: cannot read ${file}: ${err.message}`);
    process.exitCode = 1;
    continue;
  }
  const lines = text.split('\n');
  for (const [needle, why] of FORBIDDEN) {
    lines.forEach((line, i) => {
      if (line.includes(needle)) {
        console.error(`fence: ${file}:${i + 1}: forbidden "${needle}" — ${why}`);
        console.error(`    ${line.trim()}`);
        violations++;
      }
    });
  }
}

if (violations > 0) {
  console.error(
    `\nzero-9P fence FAILED: ${violations} reintroduced ext4/git access in Studio command modules.`,
  );
  console.error(
    'All file/git I/O must go through the WSL daemon (harness::repo_rpc). ' +
      'See docs/decisions/2026-06-23-daemon-in-wsl-zero-9p.md.',
  );
  process.exit(1);
}

console.log('zero-9P fence OK: Studio command modules route all file/git I/O through the daemon.');
