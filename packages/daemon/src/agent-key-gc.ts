/**
 * Agent-key GC (GAP-262).
 *
 * Liveness is the recorded PID, not `agent_sessions.started_at`. A process
 * that has been up for days is still live; a process that exited seconds
 * after register is dead. Age mis-classifies both.
 *
 * This sweep only classifies. Quarantine and deletion stay disabled until
 * the owner approves them. The bot must not delete agent keys. The gate is
 * a source constant, not an environment variable, so a deployed flag flip
 * cannot turn deletion on.
 */

import type { PGlite } from '@electric-sql/pglite';
import { createLogger } from '@revealui/utils/logger';

const log = createLogger({ service: 'revdev-daemon-agent-key-gc' });

/**
 * Owner gate. Leave false. Enabling quarantine or delete requires an
 * owner-approved change to this constant and a replacement of
 * {@link refuseQuarantineDeletes} — do not wire an env var or RPC param.
 */
export const AGENT_KEY_QUARANTINE_DELETES_ENABLED: boolean = false;

export interface AgentKeyGcReport {
  scanned: number;
  /** At least one recorded PID is still alive. */
  live: number;
  /** Every recorded PID is dead. Candidate only — keys are not removed. */
  deadPid: number;
  /** No usable PID. Not a candidate; absence of a PID is not proof of death. */
  unproven: number;
  quarantined: number;
  deleted: number;
  quarantineDeletesEnabled: boolean;
}

export interface AgentKeyGcHealth extends AgentKeyGcReport {
  lastRunAt: string | null;
}

const EMPTY_REPORT: AgentKeyGcReport = {
  scanned: 0,
  live: 0,
  deadPid: 0,
  unproven: 0,
  quarantined: 0,
  deleted: 0,
  quarantineDeletesEnabled: AGENT_KEY_QUARANTINE_DELETES_ENABLED,
};

let lastReport: AgentKeyGcReport = { ...EMPTY_REPORT };
let lastRunAt: Date | null = null;

export function agentKeyGcHealth(): AgentKeyGcHealth {
  return {
    ...lastReport,
    quarantineDeletesEnabled: AGENT_KEY_QUARANTINE_DELETES_ENABLED,
    lastRunAt: lastRunAt?.toISOString() ?? null,
  };
}

/**
 * Signal 0: the process exists (or we are not allowed to signal it).
 * ESRCH means it does not. Any other error is treated as alive so a
 * platform quirk cannot classify a live key as dead.
 *
 * PID reuse can make a dead agent's old PID look alive. That retains the
 * key, which is the safe direction while deletes are disabled.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

interface IdentityPidRow {
  agent_id: string;
  session_pid: number | null;
}

interface ProcessPidRow {
  agent_id: string;
  pid: number | null;
}

function addPid(bucket: Map<string, Set<number>>, agentId: string, pid: number | null): void {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return;
  let set = bucket.get(agentId);
  if (!set) {
    set = new Set();
    bucket.set(agentId, set);
  }
  set.add(pid);
}

/**
 * Refuse quarantine and delete. There is no SQL here on purpose: flipping
 * the gate must not start removing keys until the owner ships an approved
 * implementation.
 */
function refuseQuarantineDeletes(): never {
  throw new Error(
    'agent-key quarantine/delete is disabled (GAP-262). Refusing to remove agent keys.',
  );
}

export async function runAgentKeyGc(
  db: PGlite,
  opts?: { isPidAlive?: (pid: number) => boolean },
): Promise<AgentKeyGcReport> {
  const alive = opts?.isPidAlive ?? isPidAlive;

  // Intentionally does not read started_at. Session age is not liveness.
  const identities = await db.query<IdentityPidRow>(
    `SELECT i.agent_id, s.pid AS session_pid
       FROM agent_identity i
       LEFT JOIN agent_sessions s ON s.id = i.agent_id`,
  );
  const processes = await db.query<ProcessPidRow>(
    `SELECT owner_agent AS agent_id, pid
       FROM agent_processes
      WHERE pid IS NOT NULL`,
  );

  const pids = new Map<string, Set<number>>();
  for (const row of identities.rows) addPid(pids, row.agent_id, row.session_pid);
  for (const row of processes.rows) addPid(pids, row.agent_id, row.pid);

  let live = 0;
  let deadPid = 0;
  let unproven = 0;
  for (const row of identities.rows) {
    const recorded = pids.get(row.agent_id);
    if (!recorded || recorded.size === 0) {
      unproven++;
      continue;
    }
    let anyAlive = false;
    for (const pid of recorded) {
      if (alive(pid)) {
        anyAlive = true;
        break;
      }
    }
    if (anyAlive) live++;
    else deadPid++;
  }

  // Gate stays closed. Do not quarantine and do not delete.
  if (AGENT_KEY_QUARANTINE_DELETES_ENABLED) {
    refuseQuarantineDeletes();
  }

  const report: AgentKeyGcReport = {
    scanned: identities.rows.length,
    live,
    deadPid,
    unproven,
    quarantined: 0,
    deleted: 0,
    quarantineDeletesEnabled: false,
  };
  lastReport = report;
  lastRunAt = new Date();

  if (deadPid > 0) {
    log.info('agent-key gc classified dead PIDs; keys retained', {
      deadPid,
      live,
      unproven,
      quarantineDeletesEnabled: false,
    });
  }

  return report;
}
