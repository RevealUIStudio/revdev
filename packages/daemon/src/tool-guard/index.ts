/**
 * Native security tool-guard — the RevDev-native sibling of the Claude Code
 * PreToolUse hook's pattern scanner (GAP-366).
 *
 * `evaluateToolAction` is a pure, synchronous verdict over a normalized tool
 * action (command / read / write / delete). It consumes the shared pattern
 * manifest via the loader and never does IO. The daemon wires it into the
 * handlers that execute or mutate on behalf of agents (file.*, agent.spawn),
 * composing with — never replacing — the existing confinement + root-scoping.
 *
 * Denials surface as a JSON-RPC error with a NEW code (TOOL_GUARD_DENIED,
 * distinct from the license guard's -32001) and an events.log row carrying the
 * rule id. `initToolGuard` fails CLOSED: a daemon that cannot load its safety
 * patterns refuses to start (mirrors initLicenseGuard).
 */

import { homedir } from 'node:os';
import type { PGlite } from '@electric-sql/pglite';
import { createLogger } from '@revealui/utils/logger';
import {
  evaluateCommand,
  evaluateContentSecrets,
  isBlockedWritePath,
  isCredentialPath,
  isLockFile,
  isProtectedEnvFile,
  loadPatterns,
  type PatternManifest,
} from './patterns.js';

const log = createLogger({ service: 'revdev-daemon/tool-guard' });

/** JSON-RPC error code for a tool-guard denial (distinct from license -32001). */
export const TOOL_GUARD_DENIED = -32006;

export type ToolActionKind = 'command' | 'read' | 'write' | 'delete';

/** Normalized tool action fed to the guard. */
export interface ToolAction {
  kind: ToolActionKind;
  /** Forward-slash-normalized absolute path for read/write/delete. */
  path?: string;
  /** File content for a write. */
  content?: string;
  /** Full command line for a command action (binary + args joined). */
  command?: string;
}

export interface GuardVerdict {
  allowed: boolean;
  rule?: string;
  reason?: string;
}

const HOME = homedir();

function normalizePath(p: string): string {
  return p.split('\\').join('/');
}

function basenameOf(normPath: string): string {
  const slash = normPath.lastIndexOf('/');
  return slash === -1 ? normPath : normPath.slice(slash + 1);
}

const ALLOW: GuardVerdict = { allowed: true };

function deny(rule: string, reason: string): GuardVerdict {
  return { allowed: false, rule, reason };
}

/** Path checks shared by write + delete (credential file, system path, env/lock). */
function evaluateMutatingPath(normPath: string, manifest: PatternManifest): GuardVerdict {
  if (isCredentialPath(normPath, manifest)) {
    return deny('credential-path', `${normPath} is a protected credential file`);
  }
  if (isBlockedWritePath(normPath, HOME, manifest)) {
    return deny('blocked-write-path', `${normPath} is in a protected system path`);
  }
  const base = basenameOf(normPath);
  if (isProtectedEnvFile(base, manifest)) {
    return deny('protected-env-file', `${base} is a protected env file`);
  }
  if (isLockFile(base, manifest)) {
    return deny('protected-lock-file', `${base} is a protected lock file`);
  }
  return ALLOW;
}

/**
 * Pure, synchronous security verdict for a normalized tool action. No IO.
 * Composes with the caller's existing authorization — it never grants, only
 * denies.
 */
export function evaluateToolAction(action: ToolAction): GuardVerdict {
  const { manifest } = loadPatterns();

  switch (action.kind) {
    case 'command': {
      const command = action.command ?? '';
      const hit = evaluateCommand(command, manifest);
      return hit ? deny('dangerous-command', hit.reason) : ALLOW;
    }
    case 'read': {
      const normPath = normalizePath(action.path ?? '');
      if (isCredentialPath(normPath, manifest)) {
        return deny('credential-path', `${normPath} is a protected credential file`);
      }
      return ALLOW;
    }
    case 'write': {
      const normPath = normalizePath(action.path ?? '');
      const pathVerdict = evaluateMutatingPath(normPath, manifest);
      if (!pathVerdict.allowed) return pathVerdict;
      if (action.content) {
        const secret = evaluateContentSecrets(action.content, manifest);
        if (secret && secret.severity === 'block') {
          return deny('content-secret', `content contains ${secret.reason}`);
        }
      }
      return ALLOW;
    }
    case 'delete': {
      const normPath = normalizePath(action.path ?? '');
      return evaluateMutatingPath(normPath, manifest);
    }
    default:
      return ALLOW;
  }
}

/** Error thrown by a handler when the guard denies an action. */
export class ToolGuardError extends Error {
  readonly code = TOOL_GUARD_DENIED;
  readonly rule: string;

  constructor(verdict: GuardVerdict) {
    super(`Blocked by tool-guard: ${verdict.reason ?? 'denied'} (${verdict.rule ?? 'unknown'})`);
    this.name = 'ToolGuardError';
    this.rule = verdict.rule ?? 'unknown';
  }
}

/**
 * Log a denial to the events table, then return a ToolGuardError for the
 * handler to throw. Best-effort logging — a failed insert never masks the
 * denial itself.
 */
export async function denyToolAction(
  db: PGlite,
  method: string,
  agentId: string | null,
  verdict: GuardVerdict,
  detail: Record<string, unknown>,
): Promise<ToolGuardError> {
  try {
    await db.query(
      `INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`,
      [
        agentId ?? 'anonymous',
        'tool-guard.denied',
        JSON.stringify({ method, rule: verdict.rule, reason: verdict.reason, ...detail }),
      ],
    );
  } catch (err) {
    log.warn('failed to record tool-guard denial event', { error: String(err) });
  }
  log.warn('tool-guard denied action', {
    method,
    rule: verdict.rule,
    reason: verdict.reason,
    ...detail,
  });
  return new ToolGuardError(verdict);
}

/**
 * Initialize the tool-guard at daemon startup. Fails CLOSED: an invalid or
 * unloadable manifest throws, aborting startup with nothing to tear down
 * (called before the socket binds, like initLicenseGuard).
 */
export function initToolGuard(): { hash: string; version: number } {
  const { manifest, hash } = loadPatterns();
  log.info('tool-guard patterns loaded', {
    version: manifest.version,
    hash: hash.slice(0, 12),
    dangerousCommands: manifest.dangerousCommands.length,
    contentSecrets: manifest.contentSecrets.length,
  });
  return { hash, version: manifest.version };
}
