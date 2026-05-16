/**
 * PGlite schema types for the RevDev Harness daemon.
 *
 * Eight tables provide persistent state for multi-agent coordination:
 *   - agent_sessions: active and historical agent sessions
 *   - agent_messages: inter-agent mailbox (point-to-point + broadcast)
 *   - file_reservations: advisory file locks with CAS semantics
 *   - tasks: claimable work items with CAS ownership
 *   - events: append-only event log for audit trail
 *   - worktrees: git worktree tracking per agent
 *   - agent_memory: agent thought/action/decision log
 *   - merge_requests: merge pipeline state tracking
 *
 * Uses raw SQL (no Drizzle ORM) to keep the daemon dependency-free.
 * PGlite runs in-process — no external database needed.
 */

/** Session row shape. */
export interface AgentSession {
  id: string;
  env: string;
  task: string;
  files: string;
  pid: number | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  exit_summary: string | null;
}

/** Message row shape. */
export interface AgentMessage {
  id: number;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string;
  read: boolean;
  created_at: string;
}

/** File reservation row shape. */
export interface FileReservation {
  file_path: string;
  agent_id: string;
  reserved_at: string;
  expires_at: string;
  reason: string;
}

/** Task row shape. */
export interface AgentTask {
  id: string;
  description: string;
  status: 'open' | 'claimed' | 'completed';
  owner: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
}

/** Event row shape. */
export interface DaemonEvent {
  id: number;
  agent_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** Worktree row shape. */
export interface AgentWorktree {
  agent_id: string;
  branch: string;
  worktree_path: string;
  base_branch: string;
  status: 'active' | 'merged' | 'abandoned';
  created_at: string;
}

/** Merge request row shape. */
export interface MergeRequest {
  id: string;
  agent_id: string;
  task_id: string | null;
  source_branch: string;
  base_branch: string;
  status:
    | 'pending'
    | 'merging'
    | 'pr_created'
    | 'ci_running'
    | 'merged'
    | 'ci_failed'
    | 'conflict'
    | 'escalated';
  pr_number: number | null;
  pr_url: string | null;
  retry_count: number;
  error_message: string | null;
  ci_output: string | null;
  created_at: string;
  updated_at: string;
}

/** Memory row shape. */
export interface AgentMemoryEntry {
  id: number;
  agent_id: string;
  memory_type: 'thought' | 'action' | 'result' | 'decision' | 'disagreement';
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Agent identity row shape. */
export interface AgentIdentity {
  agent_id: string;
  did: string;
  fingerprint: string;
  public_key_pem: string;
  bootstrap_allowed: boolean;
  created_at: Date;
  last_seen_at: Date;
}

/** Agent identity key row shape. */
export interface AgentIdentityKey {
  fingerprint: string;
  agent_id: string;
  public_key_pem: string;
  created_at: Date;
  superseded_at: Date | null;
}

/** Agent identity nonce row shape. */
export interface AgentIdentityNonce {
  nonce: string;
  agent_id: string;
  seen_at: Date;
}
