import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface RevvaultGetResult {
  value: string;
  ok: true;
}

export interface RevvaultGetFailResult {
  value: null;
  ok: false;
  reason: 'missing' | 'not-found' | 'cli-not-installed' | 'unexpected-output';
}

export type RevvaultGetUnion = RevvaultGetResult | RevvaultGetFailResult;

export interface RevvaultSetResult {
  ok: true;
}

export interface RevvaultSetFailResult {
  ok: false;
  reason: 'cli-not-installed' | 'cli-failure';
}

export type RevvaultSetUnion = RevvaultSetResult | RevvaultSetFailResult;

export interface RevvaultClientOptions {
  binary?: string;
  timeout?: number;
}

export async function revvaultGet(
  path: string,
  options?: RevvaultClientOptions,
): Promise<RevvaultGetUnion> {
  const binary = options?.binary ?? 'revvault';
  const timeout = options?.timeout ?? 5000;
  try {
    const { stdout } = await execFile(binary, ['--json', 'get', path], { timeout });
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return { ok: false, value: null, reason: 'missing' } as const;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, value: null, reason: 'unexpected-output' } as const;
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'value' in parsed &&
      typeof (parsed as Record<string, unknown>).value === 'string'
    ) {
      return { ok: true, value: (parsed as Record<string, unknown>).value as string } as const;
    }
    return { ok: false, value: null, reason: 'unexpected-output' } as const;
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return { ok: false, value: null, reason: 'cli-not-installed' } as const;
    }
    const stderr = getStderr(err);
    if (stderr?.includes('not found')) {
      return { ok: false, value: null, reason: 'not-found' } as const;
    }
    return { ok: false, value: null, reason: 'unexpected-output' } as const;
  }
}

export function revvaultSet(
  path: string,
  value: string,
  options?: RevvaultClientOptions,
): Promise<RevvaultSetUnion> {
  const binary = options?.binary ?? 'revvault';
  const timeout = options?.timeout ?? 5000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RevvaultSetUnion): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    // execFileCb may throw synchronously on bad arguments (rare); guard
    // explicitly so the daemon never receives an uncaught throw from this
    // helper. The common ENOENT path (missing binary on PATH) is async —
    // see the child.on('error', ...) listener below.
    // --force: revvault set without --force fails on existing paths.
    // Identity rotation re-writes the same paths; without --force the vault
    // retains the OLD private key while the DB has the NEW DID — signing
    // would fail verification. Same pattern as scripts/issue-license.ts.
    let child: ReturnType<typeof execFileCb>;
    try {
      child = execFileCb(binary, ['--json', 'set', '--force', path], { timeout });
    } catch (err: unknown) {
      finish({ ok: false, reason: isEnoent(err) ? 'cli-not-installed' : 'cli-failure' });
      return;
    }

    // Async 'error' event covers the real-world ENOENT path: execFileCb
    // returns a child synchronously, then libuv reports the spawn failure
    // (e.g. binary not on PATH) on the next tick via 'error'. Without this
    // listener Node's default unhandled-error behavior crashes the daemon.
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ ok: false, reason: err.code === 'ENOENT' ? 'cli-not-installed' : 'cli-failure' });
    });

    child.on('exit', (code) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, reason: 'cli-failure' });
      }
    });

    // stdin can emit its own 'error' when the child died before accepting
    // input (broken pipe). Swallow it here so the daemon doesn't crash;
    // the child's 'error' or 'exit' listener above produces the actual
    // result.
    child.stdin?.on('error', () => {});

    try {
      child.stdin?.end(value);
    } catch {
      // Synchronous throw on .end() can happen if the pipe is already
      // closed; the result is reported via child's 'error' / 'exit'.
    }
  });
}

export async function isRevvaultAvailable(options?: RevvaultClientOptions): Promise<boolean> {
  const binary = options?.binary ?? 'revvault';
  const timeout = options?.timeout ?? 5000;
  try {
    await execFile(binary, ['--version'], { timeout });
    return true;
  } catch {
    return false;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as Record<string, unknown>).code === 'ENOENT'
  );
}

function getStderr(err: unknown): string | null {
  if (err !== null && typeof err === 'object' && 'stderr' in err) {
    const v = (err as Record<string, unknown>).stderr;
    return typeof v === 'string' ? v : null;
  }
  return null;
}
