/**
 * Format enforcement for the daemon file surface (GAP-309).
 *
 * Posture: **check-and-reject** (not rewrite).
 *
 * A signed `file.write` that targets a registered root which declares a
 * formatter (biome.json / Cargo.toml) is rejected with JSON-RPC -32007 when the
 * bytes differ from what the formatter would produce. The caller's content is
 * never silently rewritten — the client must re-send the formatted form.
 *
 * Why reject rather than rewrite: a daemon RPC that mutates bytes behind the
 * caller's back makes the agent believe it wrote what it sent. The Claude
 * post-edit hook rewrites for latency; that is a harness convenience. The
 * durable chokepoint (this module) refuses unformatted content so every
 * harness and human client sees the same hard failure.
 *
 * CI remains the merge guarantee; this is harness-independent edit-time
 * enforcement on the daemon path only.
 */

import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { createLogger } from '@revealui/utils/logger';
import {
  type DeclaredFormatter,
  detectDeclaredFormatter,
  isFormatExemptPath,
  repoRelativePath,
  resolveLocalBin,
  type ToolingRoot,
} from './repo-tooling.js';
import { runChild } from './vcs.js';

const log = createLogger({ service: 'revdev-daemon/format-enforce' });

/** JSON-RPC error code for format-policy rejection (GAP-309). */
export const FORMAT_REJECTED_CODE = -32007;

/** Wall-clock budget for a single formatter spawn (ms). */
const FORMAT_TIMEOUT_MS = 15_000;

export class FormatRejectedError extends Error {
  readonly code = FORMAT_REJECTED_CODE;
  readonly data: {
    kind: 'format-rejected';
    formatter: DeclaredFormatter;
    fixCommand: string;
    filePath: string;
  };

  constructor(opts: {
    message: string;
    formatter: DeclaredFormatter;
    fixCommand: string;
    filePath: string;
  }) {
    super(opts.message);
    this.name = 'FormatRejectedError';
    this.data = {
      kind: 'format-rejected',
      formatter: opts.formatter,
      fixCommand: opts.fixCommand,
      filePath: opts.filePath,
    };
  }
}

/** Extensions Biome commonly formats when a biome.json is present. */
const BIOME_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.cts',
  '.mts',
  '.json',
  '.jsonc',
  '.css',
  '.graphql',
  '.gql',
]);

function normAbs(p: string): string {
  return p.split('\\').join('/');
}

function isBiomeCandidate(filePath: string): boolean {
  return BIOME_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isCargoCandidate(filePath: string): boolean {
  return extname(filePath).toLowerCase() === '.rs';
}

/**
 * Assert content is formatted according to the repo's declared tooling.
 * No-op when the repo declares no formatter, the path is exempt, or the
 * extension is outside the formatter's domain.
 *
 * Throws FormatRejectedError on drift or missing required tooling.
 */
export async function assertFormattedContent(opts: {
  repoReal: string;
  absFile: string;
  content: string;
}): Promise<void> {
  const { repoReal, absFile, content } = opts;
  const absNorm = normAbs(absFile);

  if (isFormatExemptPath(absNorm)) {
    return;
  }

  const tooling = await detectDeclaredFormatter(repoReal, absFile);
  if (!tooling) {
    return;
  }

  if (tooling.formatter === 'biome') {
    if (!isBiomeCandidate(absFile)) return;
    await assertBiomeFormatted(tooling, repoReal, absFile, content);
    return;
  }

  if (tooling.formatter === 'cargo') {
    if (!isCargoCandidate(absFile)) return;
    await assertCargoFormatted(tooling, repoReal, absFile, content);
  }
}

async function assertBiomeFormatted(
  tooling: ToolingRoot,
  repoReal: string,
  absFile: string,
  content: string,
): Promise<void> {
  const relForStdin = relative(tooling.root, absFile).split(sep).join('/') || basename(absFile);
  const fixRel = repoRelativePath(repoReal, absFile);
  const fixCommand = `biome check --write ${fixRel}`;

  const bin = (await resolveLocalBin(tooling.root, repoReal, 'biome')) ?? 'biome';

  const result = await runChild(bin, ['format', '--stdin-file-path', relForStdin], {
    cwd: tooling.root,
    timeoutMs: FORMAT_TIMEOUT_MS,
    stdin: content,
    trimOutput: false,
  });

  if (result.aborted) {
    throw new FormatRejectedError({
      message: `file.write rejected: biome format check aborted (${result.abortReason ?? 'unknown'}) for ${fixRel}`,
      formatter: 'biome',
      fixCommand,
      filePath: fixRel,
    });
  }

  // Biome exits non-zero when the language has no formatter (e.g. .txt) or
  // when the binary is missing. If stderr says the formatter is disabled /
  // unsupported, treat as out-of-scope (pass). Any other failure is hard.
  const stderr = result.stderr;
  if (!result.ok) {
    if (
      stderr.includes('formatter is currently disabled') ||
      stderr.includes('is not supported') ||
      stderr.includes('unrecognized file extension')
    ) {
      return;
    }
    if (
      stderr.includes('ENOENT') ||
      stderr.includes('not found') ||
      (result.code === -1 && stderr.length > 0)
    ) {
      throw new FormatRejectedError({
        message: `file.write rejected: biome is declared (${tooling.configPath}) but the biome binary is unavailable for ${fixRel}. Install biome in the project or on PATH, then run: ${fixCommand}`,
        formatter: 'biome',
        fixCommand,
        filePath: fixRel,
      });
    }
    throw new FormatRejectedError({
      message: `file.write rejected: biome format check failed for ${fixRel}: ${stderr || `exit ${result.code}`}. Fix with: ${fixCommand}`,
      formatter: 'biome',
      fixCommand,
      filePath: fixRel,
    });
  }

  // Stdin format prints the formatted file on stdout (exit 0). Compare bytes
  // after normalizing only CRLF → LF so Windows clients are not punished.
  const formatted = result.stdout.replace(/\r\n/g, '\n');
  const input = content.replace(/\r\n/g, '\n');
  if (formatted !== input) {
    log.info('format-enforce rejected unformatted write', {
      formatter: 'biome',
      file: fixRel,
    });
    throw new FormatRejectedError({
      message: `file.write rejected: content is not formatted by biome for ${fixRel}. Fix with: ${fixCommand}`,
      formatter: 'biome',
      fixCommand,
      filePath: fixRel,
    });
  }
}

async function assertCargoFormatted(
  tooling: ToolingRoot,
  repoReal: string,
  absFile: string,
  content: string,
): Promise<void> {
  const fixRel = repoRelativePath(repoReal, absFile);
  const fixCommand = `cargo fmt -- ${fixRel}`;

  // cargo fmt --check needs a file on disk inside the package. Use a unique
  // sibling temp so we never overwrite the real target before the write path.
  const parent = dirname(absFile);
  const token = randomBytes(6).toString('hex');
  const tmpAbs = join(parent, `.revdev-fmt-check-${token}.rs`);
  const tmpRelFromCargo = relative(tooling.root, tmpAbs).split(sep).join('/');

  try {
    await writeFile(tmpAbs, content, 'utf8');
  } catch (err) {
    throw new FormatRejectedError({
      message: `file.write rejected: could not stage cargo fmt check for ${fixRel}: ${err instanceof Error ? err.message : String(err)}`,
      formatter: 'cargo',
      fixCommand,
      filePath: fixRel,
    });
  }

  try {
    const result = await runChild('cargo', ['fmt', '--', '--check', tmpRelFromCargo], {
      cwd: tooling.root,
      timeoutMs: FORMAT_TIMEOUT_MS,
      trimOutput: false,
    });

    if (result.aborted) {
      throw new FormatRejectedError({
        message: `file.write rejected: cargo fmt check aborted (${result.abortReason ?? 'unknown'}) for ${fixRel}`,
        formatter: 'cargo',
        fixCommand,
        filePath: fixRel,
      });
    }

    if (!result.ok) {
      // Exit 1 with "Diff in" means unformatted; missing cargo is different.
      const combined = `${result.stdout}\n${result.stderr}`;
      if (
        combined.includes('not found') ||
        combined.includes('ENOENT') ||
        (result.code === -1 && result.stderr.length > 0 && !combined.includes('Diff in'))
      ) {
        throw new FormatRejectedError({
          message: `file.write rejected: Cargo.toml declares rustfmt but cargo is unavailable for ${fixRel}. Install rustup/cargo, then run: ${fixCommand}`,
          formatter: 'cargo',
          fixCommand,
          filePath: fixRel,
        });
      }
      log.info('format-enforce rejected unformatted write', {
        formatter: 'cargo',
        file: fixRel,
      });
      throw new FormatRejectedError({
        message: `file.write rejected: content is not formatted by cargo fmt for ${fixRel}. Fix with: ${fixCommand}`,
        formatter: 'cargo',
        fixCommand,
        filePath: fixRel,
      });
    }
  } finally {
    await unlink(tmpAbs).catch(() => {});
  }
}

/** @internal — test seam for pure path exemption. */
export function _isFormatExemptPathForTest(absPathNorm: string): boolean {
  return isFormatExemptPath(absPathNorm);
}

/** @internal — re-export detector for unit tests without circular imports. */
export type { ToolingRoot };
