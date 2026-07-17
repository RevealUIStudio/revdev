/**
 * Session-lifecycle advisory-check surface.
 *
 * The per-SESSION sibling of the agent.spawn confinement / tool-guard
 * (per-ACTION) boundary. Where confinement gates a single action, this runs a
 * set of registered ADVISORY checks when a session registers and returns their
 * warnings to the client. It NEVER blocks: a session always registers, and a
 * check that throws is logged and skipped so a defect in one check can never
 * fail registration.
 *
 * The invariant mirrors the fleet "hooks only read + warn" rule: checks are
 * pure-ish reads that produce warnings, not gates. Studio / Console / any
 * customer harness surfaces the returned warnings; the daemon takes no action
 * on them.
 *
 * Zero authored regex. Reuses the shared @revealui/utils logger.
 */

import { createLogger } from '@revealui/utils/logger';
import { createDocLocationsCheck, type DocLocationsConfig } from './doc-locations.js';

const log = createLogger({ service: 'revdev-daemon/session-checks' });

/** Context handed to every session check. */
export interface SessionCheckContext {
  /**
   * Working directory / project root of the registering session. May be an
   * empty string when the client did not supply one; checks must treat that as
   * "nothing to inspect" and return a clean result.
   */
  workDir: string;
  /** Bound agent identity for the session, for log attribution. */
  agentId: string | null;
}

/** Result of a single advisory check. `ok` is false when warnings were found. */
export interface SessionCheckResult {
  ok: boolean;
  warnings: string[];
}

/**
 * An advisory check. Receives the session context, returns warnings. It must
 * never mutate state and should never throw; the runner treats a throw as a
 * skipped check, but a check that throws is a bug in that check.
 */
export type SessionCheck = (ctx: SessionCheckContext) => Promise<SessionCheckResult>;

const checks = new Map<string, SessionCheck>();

/**
 * Register (or replace) an advisory check under `name`. Registration is a plain
 * Map write and never fails; re-registering the same name overwrites, which
 * keeps `initSessionChecks()` idempotent across daemon lifecycles.
 */
export function registerSessionCheck(name: string, fn: SessionCheck): void {
  checks.set(name, fn);
}

/** Names of the currently registered checks (registration order). */
export function registeredSessionCheckNames(): string[] {
  return [...checks.keys()];
}

/** Remove all registered checks. Test-only isolation helper. */
export function clearSessionChecks(): void {
  checks.clear();
}

/**
 * Run every registered check and collect their warnings. Best-effort: each
 * check runs inside its own try/catch, so a throwing check is logged and
 * skipped and never aborts the run. Always resolves (never rejects), so the
 * caller — session.register — can never fail registration on a check error.
 */
export async function runSessionChecks(ctx: SessionCheckContext): Promise<string[]> {
  const warnings: string[] = [];
  for (const [name, fn] of checks) {
    try {
      const result = await fn(ctx);
      for (const w of result.warnings) warnings.push(w);
    } catch (err) {
      log.warn('session check threw — skipped', {
        check: name,
        agentId: ctx.agentId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return warnings;
}

/**
 * Register the daemon's built-in advisory checks. Called once from
 * startDaemon. Idempotent (each check registers under a fixed name).
 *
 * The built-in doc-locations check ships with an EMPTY ruleset, so it is a
 * no-op until a consuming project supplies canonical-path rules. This keeps the
 * surface provider-agnostic: nothing about RevFleet's own doc layout is baked
 * into the daemon.
 */
export function initSessionChecks(config: { docLocations?: DocLocationsConfig } = {}): void {
  registerSessionCheck('doc-locations', createDocLocationsCheck(config.docLocations ?? {}));
}

export type {
  DocLocationsConfig,
  RequiredFileRule,
  RestrictedDirRule,
} from './doc-locations.js';
export { createDocLocationsCheck } from './doc-locations.js';
