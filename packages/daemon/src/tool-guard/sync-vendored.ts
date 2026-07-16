/**
 * Sync the canonical tool-guard manifest to its vendored Claude Code hook copy.
 *
 * The PreToolUse hook must work with no revdev checkout and no build step, so
 * it carries a vendored copy of patterns.json. This is the one-command sync:
 * write the manifest to the hook's lib dir and print the content hash. A
 * session-start check (guard-patterns-check.js) and the daemon CI hash test
 * catch any divergence.
 *
 * Build the daemon first, then run:
 *   node packages/daemon/dist/tool-guard/sync-vendored.js
 *
 * The vendored file is pretty-printed from the in-memory manifest, so its bytes
 * may differ from the source file's formatting; the content hash (a key-sorted
 * stable serialization) is identical either way, which is what the lockstep
 * check compares.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadPatterns } from './patterns.js';

function main(): void {
  const destDir = join(homedir(), '.claude', 'hooks', 'lib');
  const dest = join(destDir, 'guard-patterns.json');

  const { hash, manifest } = loadPatterns();

  mkdirSync(destDir, { recursive: true });
  writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `tool-guard manifest v${manifest.version} synced\n` +
      `  dest:   ${dest}\n` +
      `  sha256: ${hash}\n`,
  );
}

main();
