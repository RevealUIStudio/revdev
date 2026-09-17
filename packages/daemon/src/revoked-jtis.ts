/**
 * Persistent JTI denylist for rotated/stolen licenses.
 * Default file: ~/.local/share/revealui/revoked-jtis.json
 * Override: REVEALUI_REVOKED_JTI_FILE
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function load(): Denylist {
  const path = revokedJtiPath();
  if (!existsSync(path)) return { jtis: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { jtis?: unknown };
    const jtis = Array.isArray(parsed.jtis)
      ? parsed.jtis.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [];
    return { jtis };
  } catch {
    return { jtis: [] };
  }
}

function save(list: Denylist): void {
  const path = revokedJtiPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ jtis: [...new Set(list.jtis)] }, null, 2)}\n`, 'utf8');
}

export function revokeJti(jti: string): void {
  const token = jti.trim();
  if (!token) return;
  const list = load();
  if (!list.jtis.includes(token)) list.jtis.push(token);
  save(list);
}

export function isRevokedJti(jti: string): boolean {
  const token = jti.trim();
  if (!token) return false;
  return load().jtis.includes(token);
}
