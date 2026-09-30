/**
 * Persistent JTI denylist for rotated/stolen licenses.
 * Default file: ~/.local/share/revealui/revoked-jtis.json
 * Override: REVEALUI_REVOKED_JTI_FILE
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

interface Denylist {
  jtis: string[];
}

export function revokedJtiPath(): string {
  const override = process.env.REVEALUI_REVOKED_JTI_FILE?.trim();
  if (override) return override;
  return join(homedir(), '.local/share/revealui/revoked-jtis.json');
}

/** Corrupt or unreadable revocation state cannot authorize a paid token. */
export class RevocationStateError extends Error {
  constructor(cause?: unknown) {
    super('local license revocation state is unavailable or invalid', { cause });
    this.name = 'RevocationStateError';
  }
}

function load(): Denylist {
  let contents: string;
  try {
    contents = readFileSync(revokedJtiPath(), 'utf8');
  } catch (error) {
    // An absent store is the supported initial state. Other I/O failures must
    // not erase recorded revocations or become an empty authorization state.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jtis: [] };
    throw new RevocationStateError();
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('jtis' in parsed) ||
      !Array.isArray(parsed.jtis) ||
      !parsed.jtis.every(
        (value: unknown) => typeof value === 'string' && value.length > 0 && value === value.trim(),
      )
    ) {
      throw new RevocationStateError();
    }
    return { jtis: parsed.jtis };
  } catch {
    throw new RevocationStateError();
  }
}

function save(list: Denylist): void {
  const path = revokedJtiPath();
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify({ jtis: [...new Set(list.jtis)] }, null, 2)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    // Only this operation's exclusive temporary file is owned here.
    rmSync(temporary, { force: true });
  }
}

export function revokeJti(jti: string): void {
  const token = jti.trim();
  if (!token) return;
  const path = revokedJtiPath();
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let fd: number;
  try {
    // Concurrent writers fail explicitly instead of overwriting each other's
    // read/modify/write. Never remove another operation's lock or guess expiry.
    fd = openSync(lock, 'wx', 0o600);
  } catch (error) {
    throw new RevocationStateError(error);
  }
  try {
    const list = load();
    if (!list.jtis.includes(token)) list.jtis.push(token);
    save(list);
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

function assertNoPendingWrite(): void {
  try {
    lstatSync(`${revokedJtiPath()}.lock`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new RevocationStateError();
  }
  // An interrupted writer leaves an unavailable store, never permission to
  // use a possibly revoked credential. Recovery requires the maintained owner.
  throw new RevocationStateError();
}

export function isRevokedJti(jti: string): boolean {
  const token = jti.trim();
  assertNoPendingWrite();
  const list = load();
  return Boolean(token) && list.jtis.includes(token);
}
