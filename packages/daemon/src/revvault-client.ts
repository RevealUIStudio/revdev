import { execFile as execFileCb } from 'node:child_process';
import { once } from 'node:events';
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

export async function revvaultSet(
  path: string,
  value: string,
  options?: RevvaultClientOptions,
): Promise<RevvaultSetUnion> {
  const binary = options?.binary ?? 'revvault';
  const timeout = options?.timeout ?? 5000;
  try {
    // --force: revvault set without --force fails on existing paths. Identity
    // rotation re-writes the same paths, so without --force the vault retains
    // the OLD private key while the DB has the NEW DID — signing would fail
    // verification. Same pattern as scripts/issue-license.ts.
    const child = execFileCb(binary, ['--json', 'set', '--force', path], { timeout });
    child.stdin?.end(value);
    await once(child, 'exit');
    const code = child.exitCode;
    if (code !== 0) {
      return { ok: false, reason: 'cli-failure' } as const;
    }
    return { ok: true } as const;
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return { ok: false, reason: 'cli-not-installed' } as const;
    }
    return { ok: false, reason: 'cli-failure' } as const;
  }
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
