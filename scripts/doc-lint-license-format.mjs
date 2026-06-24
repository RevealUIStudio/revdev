#!/usr/bin/env node
/**
 * Doc-lint: reject the legacy license-key formats in user-facing docs.
 *
 * The daemon hard-rejects the legacy `RVUI.v2.*` (dotted-v2) and `RVUI-*`
 * (v1) license formats — current keys are Ed25519-signed JWTs starting with
 * `eyJ` (see packages/daemon/src/license.ts). A 2026-06-23 audit found the
 * docs still instructed customers to set the rejected format, silently
 * landing every paying first-run user on FREE tier. This lint is the durable
 * guard against that drift re-appearing.
 *
 * It scans every tracked Markdown file and fails on any occurrence of a
 * legacy token. Legitimate mentions (docs that explain the format is
 * *rejected*) opt out explicitly:
 *   - inline:  append  <!-- doclint:allow-legacy-format -->  to the line
 *   - block:   wrap the region in
 *                <!-- doclint:allow-legacy-format:start -->
 *                ...
 *                <!-- doclint:allow-legacy-format:end -->
 * Block markers are required for fenced code blocks, where an inline HTML
 * comment would render literally.
 *
 * Fixed-string matching only (no regex) — typed predicates over each line.
 * Zero dependencies; runs under plain `node`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LEGACY_TOKENS = ['RVUI.v2.', 'RVUI-'];
const ALLOW_START = 'doclint:allow-legacy-format:start';
const ALLOW_END = 'doclint:allow-legacy-format:end';
const ALLOW_INLINE = 'doclint:allow-legacy-format';

function trackedMarkdownFiles() {
  const out = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf-8' });
  // Analysis docs (audits) legitimately quote the rejected legacy formats
  // while documenting that they ARE rejected; this lint targets instruction
  // docs only, so exclude the audit/analysis tree.
  return out
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.startsWith('docs/audits/'));
}

function hasLegacyToken(line) {
  return LEGACY_TOKENS.some((token) => line.includes(token));
}

const violations = [];

for (const file of trackedMarkdownFiles()) {
  let contents;
  try {
    contents = readFileSync(file, 'utf-8');
  } catch {
    continue;
  }
  let inAllowBlock = false;
  contents.split('\n').forEach((line, index) => {
    if (line.includes(ALLOW_START)) {
      inAllowBlock = true;
      return;
    }
    if (line.includes(ALLOW_END)) {
      inAllowBlock = false;
      return;
    }
    if (!hasLegacyToken(line)) return;
    if (inAllowBlock) return;
    // ALLOW_INLINE is a prefix of ALLOW_START; the start/end branches above
    // already returned, so any inline marker here is a genuine line-level opt-out.
    if (line.includes(ALLOW_INLINE)) return;
    violations.push({ file, line: index + 1, text: line.trim() });
  });
}

if (violations.length > 0) {
  console.error(
    'Doc-lint FAILED: a rejected legacy license format (RVUI.v2.* / RVUI-*) appears in docs.',
  );
  console.error('Current license keys are Ed25519-signed JWTs starting with "eyJ".');
  console.error(
    'If a mention is intentional (documenting that the format is REJECTED), opt out with',
  );
  console.error(
    `an inline <!-- ${ALLOW_INLINE} --> marker or a <!-- ${ALLOW_START} --> / <!-- ${ALLOW_END} --> block.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.text}`);
  }
  process.exit(1);
}

console.log('Doc-lint OK — no rejected legacy license formats in tracked Markdown.');
