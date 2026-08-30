import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { markDegraded } from './degraded-mode';

const MOCK_COMMIT_RECENT_S = 300; // 5 minutes ago
const MOCK_COMMIT_OLDER_S = 3600; // 1 hour ago

import type {
  AgentBackend,
  AgentSession,
  AgentSessionInfo,
  AppStatus,
  GitBranch,
  GitCommitInfo,
  GitDiffContent,
  GitPullResult,
  GitPushResult,
  GitStatusResult,
  HarnessAgentProcess,
  HarnessApproval,
  HarnessClaimResult,
  HarnessDecideResult,
  HarnessMessage,
  HarnessReservation,
  HarnessReserveResult,
  HarnessSession,
  HarnessSetModeResult,
  HarnessTask,
  LocalAiProfileView,
  LocalAiTier,
  ModelPullResult,
  MountStatus,
  OllamaModel,
  OllamaStatus,
  SecretInfo,
  SetupStatus,
  SnapModel,
  SnapStatus,
  SshBookmark,
  SshConnectParams,
  StudioConfig,
  SyncResult,
  SystemStatus,
  TerminalProfile,
} from '../types';

/** True when running inside the Tauri webview (IPC bridge available) */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ── Browser-mode mock data (used when Tauri IPC is unavailable) ───────────

const MOCK_DATA: Record<string, unknown> = {
  get_system_status: {
    wsl_running: true,
    distribution: 'Ubuntu-24.04 (mock)',
    tier: 'pro',
    systemd_status: 'running',
  } satisfies SystemStatus,
  read_fleet_map: {
    jvRoot: 'mock-planning-root',
    snapshotPath: 'mock-planning-root/docs/tracker-snapshot.json',
    statePath: null,
    snapshot: {
      schema: 'tracker-snapshot-v1',
      generatedAt: '2026-08-08T00:00:00.000Z',
      initiatives: [
        {
          id: 'INIT-002',
          name: 'RevDev daily driver + agent runtime',
          priority: 'P0',
          state: 'active',
          progress: { gapsOpen: 19, gapsClosed: 0, gapsListed: 19, lanesActive: 4, lanesPaused: 0 },
        },
      ],
      freeSurfaces: [{ id: 'GAP-154', priority: 'high', initiativeId: 'INIT-002' }],
      nodes: [{ id: 'INIT-002' }, { id: 'GAP-154' }],
      edges: [{ from: 'INIT-002', to: 'GAP-154', relation: 'member' }],
    },
    state: null,
    generatedAt: '2026-08-08T00:00:00.000Z',
    freeSurfaceCount: 1,
    initiativeCount: 1,
    nodeCount: 2,
    edgeCount: 1,
  },
  get_mount_status: {
    mounted: false,
    mount_point: '/mnt/wsl-dev',
    device: null,
    size_total: null,
    size_used: null,
    size_available: null,
    use_percent: null,
  } satisfies MountStatus,
  check_setup: {
    wsl_running: true,
    nix_installed: true,
    devbox_mounted: false,
    git_name: 'RevealUI Studio',
    git_email: 'noreply@revealui.com',
  } satisfies SetupStatus,
  list_apps: [
    {
      app: { name: 'api', display_name: 'API', port: 3004, url: 'http://localhost:3004' },
      running: false,
    },
    {
      app: { name: 'admin', display_name: 'Admin', port: 4000, url: 'http://localhost:4000' },
      running: false,
    },
    {
      app: { name: 'docs', display_name: 'Docs', port: 3002, url: 'http://localhost:3002' },
      running: false,
    },
    {
      app: {
        name: 'marketing',
        display_name: 'Marketing',
        port: 3000,
        url: 'http://localhost:3000',
      },
      running: false,
    },
  ] satisfies AppStatus[],
  sync_all_repos: [] satisfies SyncResult[],
  vault_is_initialized: true,
  vault_list: [
    { path: 'stripe/secret_key', namespace: 'stripe' },
    { path: 'neon/database_url', namespace: 'neon' },
    { path: 'vercel/api_token', namespace: 'vercel' },
  ] satisfies SecretInfo[],
  vault_search: [] satisfies SecretInfo[],
  vault_get: '••••••••',
  // Void / string commands return simple defaults
  mount_devbox: 'Mounted (mock)',
  unmount_devbox: 'Unmounted (mock)',
  daemon_setup: 'Relay installed (mock)',
  start_app: 'Started (mock)',
  stop_app: 'Stopped (mock)',
  ssh_connect: 'mock-session-id',
  set_git_identity: undefined,
  vault_init: undefined,
  vault_set: undefined,
  vault_delete: undefined,
  vault_copy: undefined,
  ssh_disconnect: undefined,
  ssh_send: undefined,
  ssh_resize: undefined,
  sync_repo: { drive: 'C', repo: 'RevealUI', status: 'ok', branch: 'main' } satisfies SyncResult,
  read_app_log: '[mock] No log output available',
  ssh_bookmark_list: [] satisfies SshBookmark[],
  ssh_bookmark_save: undefined,
  ssh_bookmark_delete: undefined,
  get_config: {
    intent: null,
    setupComplete: false,
    completedSteps: [],
    deploy: null,
    develop: null,
    wizardDraft: undefined,
  } satisfies StudioConfig,
  set_config: undefined,
  reset_config: undefined,
  shell_open: 'mock-shell-session-id',
  shell_close: undefined,
  shell_send: undefined,
  shell_resize: undefined,
  git_status: {
    branch: 'main',
    staged: [{ path: 'apps/studio/src/types.ts', status: 'modified' }],
    unstaged: [{ path: 'apps/api/src/index.ts', status: 'modified' }],
    untracked: [{ path: 'apps/studio/src/components/git/GitPanel.tsx', status: 'untracked' }],
  } satisfies GitStatusResult,
  git_diff_file:
    '--- a/apps/studio/src/types.ts\n+++ b/apps/studio/src/types.ts\n@@ -1,3 +1,6 @@\n /** Mirrors Rust SystemStatus struct */\n+\n+export type GitFileStatusKind = "modified" | "new";\n+\n export interface SystemStatus {\n',
  git_stage_file: undefined,
  git_unstage_file: undefined,
  git_discard_file: undefined,
  git_commit: 'abc1234def5678901234567890abcdef12345678',
  git_list_branches: [
    { name: 'main', is_current: true },
    { name: 'feat/shell-v1', is_current: false },
  ] satisfies GitBranch[],
  git_create_branch: undefined,
  git_switch_branch: undefined,
  git_delete_branch: undefined,
  git_push: { success: true, message: 'Everything up-to-date' } satisfies GitPushResult,
  git_pull: { success: true, message: 'Already up to date.' } satisfies GitPullResult,
  git_log: [
    {
      sha: 'abc1234def5678901234567890abcdef12345678',
      short_sha: 'abc1234',
      message: 'feat(studio): add CodeMirror editor + branch management',
      author: 'RevealUI Studio',
      timestamp: BigInt(Math.floor(Date.now() / 1000) - MOCK_COMMIT_RECENT_S),
    },
    {
      sha: 'def5678901234567890abcdef12345678abc1234',
      short_sha: 'def5678',
      message: 'feat(studio): git panel MVP — status, diff, stage, commit',
      author: 'RevealUI Studio',
      timestamp: BigInt(Math.floor(Date.now() / 1000) - MOCK_COMMIT_OLDER_S),
    },
  ] satisfies GitCommitInfo[],
  git_read_file: '// Mock file content\nexport default function example() {}\n',
  git_write_file: undefined,
  agent_spawn: 'mock-agent-session-id',
  harness_agent_spawn: {
    process_id: 'mock-harness-proc',
    command: 'bash',
    cwd: '/tmp/repo',
    pid: 4242,
    status: 'running',
    exit_code: null,
  } satisfies HarnessAgentProcess,
  harness_agent_list: [
    {
      process_id: 'mock-harness-proc',
      command: 'bash',
      cwd: '/tmp/repo',
      pid: 4242,
      status: 'running',
      exit_code: null,
    },
  ] satisfies HarnessAgentProcess[],
  harness_agent_stop: undefined,
  harness_agent_remove: undefined,
  agent_stop: undefined,
  agent_list: [] satisfies AgentSessionInfo[],
  agent_remove: undefined,
  agent_input: undefined,
  agent_resize: undefined,
  detect_browser_profiles: [] as Array<{
    directory: string;
    name: string;
    browser: string;
  }>,
  list_running_processes: [] as string[],
  launch_allowed_program: undefined,
  inference_profile_get: {
    tier: 'idle',
    provider: null,
    model: null,
    baseUrl: null,
    ollamaModelsDir: '/mnt/studio/models/ollama',
    keepAlive: '0',
    updatedAt: '2026-07-24T00:00:00Z',
    note: 'AI stopped — IDE/dev headroom',
    memAvailableGib: 2.1,
    ollamaRunning: false,
    snapsRunning: [],
  } satisfies LocalAiProfileView,
  inference_profile_apply: {
    tier: 'idle',
    provider: null,
    model: null,
    baseUrl: null,
    ollamaModelsDir: '/mnt/studio/models/ollama',
    keepAlive: '0',
    updatedAt: '2026-07-24T00:00:00Z',
    note: 'AI stopped — IDE/dev headroom',
    memAvailableGib: 2.1,
    ollamaRunning: false,
    snapsRunning: [],
  } satisfies LocalAiProfileView,
  inference_ollama_status: {
    installed: false,
    running: false,
    version: null,
  } satisfies OllamaStatus,
  inference_ollama_models: [] satisfies OllamaModel[],
  inference_ollama_pull: { success: true, message: 'Pulled (mock)' } satisfies ModelPullResult,
  inference_ollama_delete: undefined,
  inference_ollama_start: undefined,
  inference_ollama_stop: undefined,
  inference_snap_status: {
    installed: false,
    running: false,
    snap_name: 'nemotron-3-nano',
    endpoint: null,
    version: null,
  } satisfies SnapStatus,
  inference_snap_list: [
    {
      name: 'nemotron-3-nano',
      description: 'NVIDIA (US) — general + tools; product default',
      installed: false,
    },
    {
      name: 'nemotron-3-nano-omni',
      description: 'NVIDIA (US) — multimodal (text/image/video/audio)',
      installed: false,
    },
    {
      name: 'gemma4',
      description: 'Google (US) — general + vision + tools',
      installed: false,
    },
    {
      name: 'gemma3',
      description: 'Google (US) — general + vision (allowlisted)',
      installed: false,
    },
  ] satisfies SnapModel[],
  inference_snap_install: { success: true, message: 'Installed (mock)' } satisfies ModelPullResult,
  inference_snap_remove: undefined,
  agent_read_workboard: [
    '# RevealUI Workboard',
    '_Last updated: 2026-03-18T20:00Z_',
    '',
    '## Active Sessions',
    '',
    '| id | env | started | task | files | updated |',
    '|----|-----|---------|------|-------|---------|',
    '| conductor | wsl | 2026-03-18T16:31Z | Building agent session panel | apps/studio/src/components/agent/AgentPanel.tsx | 2026-03-18T20:25Z |',
    '| zed-extension | zed | 2026-03-18T15:00Z | idle | — | 2026-03-18T18:00Z |',
    '',
    '## Recent',
    '',
    '- [2026-03-18 18:00] conductor: Fixed settings-layout test failures',
    '- [2026-03-18 14:00] zed-extension: Biome lint cleanup',
  ].join('\n'),

  // ── Harness Daemon ──────────────────────────────────────────────────────
  harness_ping: true,
  harness_sessions: [
    {
      id: 'agent-ext-1',
      env: 'zed',
      task: 'Implementing harness UI',
      files: 'apps/studio/src/components/agent/*',
      pid: 12345,
      started_at: new Date(Date.now() - 3600_000).toISOString(),
      updated_at: new Date().toISOString(),
      ended_at: null,
      exit_summary: null,
    },
  ] satisfies HarnessSession[],
  harness_inbox: [
    {
      id: 1,
      from_agent: 'conductor',
      to_agent: 'agent-ext-1',
      subject: 'Schema migration ready',
      body: 'The new idempotency_keys table is migrated. You can start using it.',
      read: false,
      created_at: new Date(Date.now() - 1800_000).toISOString(),
    },
  ] satisfies HarnessMessage[],
  harness_send_message: {
    id: 2,
    from_agent: 'agent-ext-1',
    to_agent: 'conductor',
    subject: 'Acknowledged',
    body: 'Will integrate shortly.',
    read: false,
    created_at: new Date().toISOString(),
  } satisfies HarnessMessage,
  harness_broadcast: 1,
  harness_mark_read: undefined,
  harness_tasks: [
    {
      id: 'task-001',
      description: 'Add WebSocket live status to agent panel',
      status: 'open',
      owner: null,
      claimed_at: null,
      completed_at: null,
      created_at: new Date(Date.now() - 7200_000).toISOString(),
    },
    {
      id: 'task-002',
      description: 'Build message compose UI',
      status: 'claimed',
      owner: 'agent-ext-1',
      claimed_at: new Date(Date.now() - 1800_000).toISOString(),
      completed_at: null,
      created_at: new Date(Date.now() - 7200_000).toISOString(),
    },
  ] satisfies HarnessTask[],
  harness_create_task: {
    id: 'task-003',
    description: 'New task (mock)',
    status: 'open',
    owner: null,
    claimed_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
  } satisfies HarnessTask,
  harness_claim_task: { success: true, owner: 'agent-ext-1' } satisfies HarnessClaimResult,
  harness_complete_task: true,
  // GAP-362 mock: timeout with no event (browser demo has no live work bus)
  harness_events_wait: { event: null, timedOut: true },
  harness_release_task: true,
  harness_reservations: [
    {
      file_path: 'apps/studio/src/components/agent/AgentPanel.tsx',
      agent_id: 'agent-ext-1',
      reserved_at: new Date(Date.now() - 900_000).toISOString(),
      expires_at: new Date(Date.now() + 2700_000).toISOString(),
      reason: 'Active editing — harness UI',
    },
  ] satisfies HarnessReservation[],
  harness_reserve_file: { success: true } satisfies HarnessReserveResult,
  harness_check_file: null,
  harness_permission_pending: [
    {
      id: 'apr-mock-1',
      agent_id: 'agent-ext-1',
      method: 'git.push',
      params_hash: 'abc123',
      summary: 'git.push origin main',
      requested_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 1_800_000).toISOString(),
      status: 'pending',
    },
  ] satisfies HarnessApproval[],
  harness_permission_decide: { id: 'apr-mock-1', status: 'approved' } satisfies HarnessDecideResult,
  harness_permission_set_mode: {
    agent_id: 'agent-ext-1',
    permission_mode: 'manual',
    daemon_default: 'shadow',
  } satisfies HarnessSetModeResult,
};

// ── Remote daemon HTTP transport (browser mode) ─────────────────────────────

const DAEMON_URL_KEY = 'revdev-daemon-url';
const DAEMON_TOKEN_KEY = 'revdev-daemon-token';

/**
 * Command-to-RPC method mapping for harness commands.
 * Every value MUST be a method the daemon actually registers
 * (packages/daemon registerHandler call sites) — an unregistered method
 * dies as JSON-RPC -32601 with no useful signal to the user. A studio vitest
 * asserts every value here is a member of the protocol's RPC_METHODS, which is
 * itself contract-tested against the daemon registry.
 */
export const HARNESS_RPC_MAP: Record<string, string> = {
  harness_ping: 'ping',
  harness_sessions: 'session.list',
  harness_inbox: 'mail.inbox',
  harness_send_message: 'mail.send',
  harness_broadcast: 'mail.broadcast',
  harness_mark_read: 'mail.markRead',
  harness_tasks: 'tasks.list',
  harness_create_task: 'tasks.create',
  harness_claim_task: 'tasks.claim',
  harness_complete_task: 'tasks.complete',
  harness_release_task: 'tasks.release',
  harness_reservations: 'files.list',
  harness_reserve_file: 'files.reserve',
  harness_check_file: 'files.check',
  // GAP-362: long-poll work.completed (prefer over client sub-minute task polls)
  harness_events_wait: 'events.wait',
  // GAP-294 permission modes
  harness_permission_pending: 'permission.pending',
  harness_permission_decide: 'permission.decide',
  harness_permission_set_mode: 'permission.setMode',
  // Agent spawner
  // Local inference (Tauri-only in desktop); browser maps to daemon agent.*
  agent_spawn: 'agent.spawn',
  agent_stop: 'agent.stop',
  agent_list: 'agent.list',
  agent_remove: 'agent.remove',
  agent_input: 'agent.input',
  agent_resize: 'agent.resize',
  // Confined harness spawn (INIT-002 PW-SPAWN) — same daemon methods, explicit commands
  harness_agent_spawn: 'agent.spawn',
  harness_agent_list: 'agent.list',
  harness_agent_stop: 'agent.stop',
  harness_agent_remove: 'agent.remove',
  // Local inference (Ollama) — the daemon's inference.* handlers ARE the Ollama
  // HTTP integration. Result shapes differ from the Tauri path and are adapted
  // back to the Studio types by RESULT_ADAPTERS below. `inference_ollama_models`
  // reuses inference.status because that method already returns the model list;
  // there is no separate daemon "models" method to add.
  inference_ollama_status: 'inference.status',
  inference_ollama_models: 'inference.status',
  inference_ollama_pull: 'inference.pull',
  inference_ollama_delete: 'inference.delete',
};

/**
 * Commands implemented only by the Tauri (Rust) backend, with no daemon
 * equivalent. When a remote daemon IS configured, these fail loudly instead of
 * silently calling a nonexistent method or serving fabricated mock state next
 * to real data.
 *
 *   - inference_ollama_start / _stop manage the Ollama SERVER lifecycle
 *     (`ollama serve` / `pkill`). The daemon only speaks HTTP to an
 *     already-running Ollama, so it cannot start or stop a host process. (The
 *     daemon's inference.start/stop are model warm/unload, a different op.)
 *   - inference_snap_* are host snap package management (sudo snap
 *     install/remove); the daemon does not manage host packages.
 */
const DESKTOP_ONLY_COMMANDS = new Set([
  'inference_ollama_start',
  'inference_ollama_stop',
  'inference_snap_list',
  'inference_snap_status',
  'inference_snap_install',
  'inference_snap_remove',
]);

/** Map Tauri command args (snake_case) to RPC params (camelCase) */
function toRpcParams(cmd: string, args?: Record<string, unknown>): Record<string, unknown> {
  if (!args) return {};
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    // Convert snake_case to camelCase
    const camel = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    params[camel] = value;
  }
  // Special cases for harness_ping which returns boolean
  if (cmd === 'harness_ping') return {};
  // Harness agent spawn: map Studio args → daemon agent.spawn params.
  if (cmd === 'harness_agent_spawn') {
    return {
      command: params.command,
      args: Array.isArray(params.args) ? params.args : [],
      repoPath: params.repoPath ?? params.repo_path,
      cwd: params.cwd ?? undefined,
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
    };
  }
  if (cmd === 'harness_agent_stop' || cmd === 'harness_agent_remove') {
    return { processId: params.processId ?? params.process_id };
  }
  if (cmd === 'agent_spawn' && params.command) {
    // Browser mode confined spawn when callers pass command/repoPath.
    return {
      command: params.command,
      args: Array.isArray(params.args) ? params.args : [],
      repoPath: params.repoPath ?? params.repo_path,
      cwd: params.cwd ?? undefined,
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
    };
  }
  // The Ollama model commands take a `modelName` arg on the Studio wrappers, but
  // the daemon's inference.pull/delete handlers read `model`. Rename so the
  // daemon receives the key its schema requires.
  if (
    (cmd === 'inference_ollama_pull' || cmd === 'inference_ollama_delete') &&
    params.modelName !== undefined
  ) {
    params.model = params.modelName;
    delete params.modelName;
  }
  return params;
}

// ── Browser-mode result adapters ────────────────────────────────────────────
// The daemon's inference.* and agent.list results use the daemon's own vocabulary
// and differ from the shapes the Tauri (Rust) path returns. These adapters map a
// daemon result back to the Studio type so browser mode and desktop mode return
// identical shapes to callers.

interface DaemonOllamaStatus {
  running?: boolean;
  version?: string;
  models?: Array<{ name: string; sizeMb: number; modified: string }>;
}

/** Format a daemon `sizeMb` integer as the human string the Tauri path emits. */
function formatModelSize(sizeMb: number): string {
  if (!Number.isFinite(sizeMb) || sizeMb <= 0) return '';
  if (sizeMb >= 1000) return `${(sizeMb / 1000).toFixed(1)} GB`;
  return `${sizeMb} MB`;
}

function adaptOllamaStatus(raw: unknown): OllamaStatus {
  const s = (raw ?? {}) as DaemonOllamaStatus;
  // The daemon speaks HTTP to Ollama; it can only confirm `installed` when the
  // server answers. A not-running server is indistinguishable from a missing
  // one over HTTP, so `installed` tracks `running` — the honest best effort.
  const running = s.running === true;
  return { installed: running, running, version: s.version ?? null };
}

function adaptOllamaModels(raw: unknown): OllamaModel[] {
  const s = (raw ?? {}) as DaemonOllamaStatus;
  return (s.models ?? []).map((m) => ({
    name: m.name,
    size: formatModelSize(m.sizeMb),
    modified: m.modified,
  }));
}

interface DaemonPullResult {
  success?: boolean;
  status?: string;
  model?: string;
  error?: string;
}

function adaptOllamaPull(raw: unknown): ModelPullResult {
  const r = (raw ?? {}) as DaemonPullResult;
  const success = r.success === true;
  if (success) {
    return { success: true, message: r.status ?? `Pulled ${r.model ?? ''}`.trim() };
  }
  return { success: false, message: r.error ?? 'Pull failed' };
}

interface DaemonAgentProcess {
  processId: string;
  command: string;
  pid: number | null;
  status: string;
  exitCode: number | null;
}

function daemonStatusToSession(
  status: string,
  exitCode: number | null,
): AgentSessionInfo['status'] {
  if (status === 'running') return 'running';
  if (status === 'exited') return exitCode !== null && exitCode !== 0 ? 'errored' : 'stopped';
  // 'killed' and any unrecognized terminal state read as a clean stop.
  return 'stopped';
}

function adaptAgentList(raw: unknown): AgentSessionInfo[] {
  const rows = Array.isArray(raw) ? (raw as DaemonAgentProcess[]) : [];
  // The daemon's agent.spawn is a generic command spawner: its registry has no
  // inference backend, model, or prompt. `command` is the only human label; the
  // rest are empty and `backend` is null (a daemon-spawned PTY, not Snap/Ollama).
  return rows.map((r) => ({
    id: r.processId,
    name: r.command,
    model: '',
    backend: null,
    prompt: '',
    status: daemonStatusToSession(r.status, r.exitCode),
    pid: r.pid,
    harness: true,
  }));
}

function adaptPermissionPending(raw: unknown): HarnessApproval[] {
  const r = (raw ?? {}) as { approvals?: unknown[] };
  const rows = Array.isArray(r.approvals) ? r.approvals : Array.isArray(raw) ? raw : [];
  return rows.map((row) => {
    const o = (row ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? ''),
      agent_id: String(o.agentId ?? o.agent_id ?? ''),
      method: String(o.method ?? ''),
      params_hash: String(o.paramsHash ?? o.params_hash ?? ''),
      summary: String(o.summary ?? ''),
      requested_at: String(o.requestedAt ?? o.requested_at ?? ''),
      expires_at: String(o.expiresAt ?? o.expires_at ?? ''),
      status: String(o.status ?? 'pending'),
    };
  });
}

function adaptPermissionDecide(raw: unknown): HarnessDecideResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { id: String(o.id ?? ''), status: String(o.status ?? '') };
}

function adaptPermissionSetMode(raw: unknown): HarnessSetModeResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    agent_id: String(o.agentId ?? o.agent_id ?? ''),
    permission_mode:
      o.permissionMode === null || o.permissionMode === undefined
        ? null
        : String(o.permissionMode ?? o.permission_mode ?? ''),
    daemon_default:
      o.daemonDefault === null || o.daemonDefault === undefined
        ? null
        : String(o.daemonDefault ?? o.daemon_default ?? ''),
  };
}

function adaptHarnessSessions(raw: unknown): HarnessSession[] {
  const r = (raw ?? {}) as { sessions?: unknown[] };
  const rows = Array.isArray(r.sessions) ? r.sessions : Array.isArray(raw) ? raw : [];
  return rows.map((row) => {
    const o = (row ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? ''),
      env: String(o.env ?? ''),
      task: String(o.task ?? ''),
      files: o.files == null ? null : String(o.files),
      pid: typeof o.pid === 'number' ? o.pid : null,
      started_at: String(o.started_at ?? o.startedAt ?? ''),
      updated_at: String(o.updated_at ?? o.updatedAt ?? ''),
      ended_at: o.ended_at == null && o.endedAt == null ? null : String(o.ended_at ?? o.endedAt),
      exit_summary:
        o.exit_summary == null && o.exitSummary == null
          ? null
          : String(o.exit_summary ?? o.exitSummary),
      activity_state:
        o.activity_state == null && o.activityState == null
          ? null
          : String(o.activity_state ?? o.activityState),
      blocked_reason:
        o.blocked_reason == null && o.blockedReason == null
          ? null
          : String(o.blocked_reason ?? o.blockedReason),
      permission_mode:
        o.permission_mode == null && o.permissionMode == null
          ? null
          : String(o.permission_mode ?? o.permissionMode),
    };
  });
}

function adaptHarnessAgentSpawn(raw: unknown): HarnessAgentProcess {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    process_id: String(o.processId ?? o.process_id ?? ''),
    command: String(o.command ?? ''),
    cwd: o.cwd == null ? null : String(o.cwd),
    pid: typeof o.pid === 'number' ? o.pid : null,
    status: String(o.status ?? 'running'),
    exit_code:
      typeof o.exitCode === 'number'
        ? o.exitCode
        : typeof o.exit_code === 'number'
          ? o.exit_code
          : null,
  };
}

function adaptHarnessAgentList(raw: unknown): HarnessAgentProcess[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((row) => adaptHarnessAgentSpawn(row));
}

/** Per-command adapters applied to the daemon RPC result in browser mode. */
const RESULT_ADAPTERS: Record<string, (raw: unknown) => unknown> = {
  agent_list: adaptAgentList,
  harness_agent_list: adaptHarnessAgentList,
  harness_agent_spawn: adaptHarnessAgentSpawn,
  inference_ollama_status: adaptOllamaStatus,
  inference_ollama_models: adaptOllamaModels,
  inference_ollama_pull: adaptOllamaPull,
  harness_sessions: adaptHarnessSessions,
  harness_permission_pending: adaptPermissionPending,
  harness_permission_decide: adaptPermissionDecide,
  harness_permission_set_mode: adaptPermissionSetMode,
};

/** Get the configured daemon URL from localStorage */
export function getDaemonUrl(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(DAEMON_URL_KEY);
}

/** Set the daemon URL for remote access */
export function setDaemonUrl(url: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (url) {
    localStorage.setItem(DAEMON_URL_KEY, url);
  } else {
    localStorage.removeItem(DAEMON_URL_KEY);
  }
}

/** Get the stored session token */
export function getDaemonToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(DAEMON_TOKEN_KEY);
}

/** Store a session token (obtained from pairing) */
export function setDaemonToken(token: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (token) {
    localStorage.setItem(DAEMON_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(DAEMON_TOKEN_KEY);
  }
}

/**
 * HMAC-SHA256(secret, message) → hex digest.
 * Matches @revealui/harnesses HttpGateway (GAP-353): secret and nonce are
 * hex strings treated as UTF-8 for createHmac / SubtleCrypto.
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface PairWithDaemonOptions {
  /** Absolute gateway base URL (e.g. http://127.0.0.1:8787) */
  daemonUrl: string;
  /**
   * Contents of the 0600 pairing-secret file printed at gateway boot
   * (hex string). Used only as a local HMAC key — never sent on the wire.
   */
  secret: string;
  /** Optional operator label stored with the durable token */
  label?: string;
}

/**
 * Pair with a fail-closed harness HTTP gateway (challenge-response).
 *
 * Contract (GAP-353 / @revealui/harnesses):
 *   1. GET  /api/pair → { nonce, expiresIn }
 *   2. POST /api/pair { nonce, hmac, label? } where hmac = HMAC-SHA256(secret, nonce)
 *   3. Response { token, expiresAt } — store as bearer for /rpc
 *
 * The retired 6-digit pairing-code POST is gone; do not reintroduce it.
 */
export async function pairWithDaemon(options: PairWithDaemonOptions): Promise<string> {
  const { daemonUrl, secret, label } = options;
  const base = daemonUrl.replace(/\/$/, '');
  if (!secret.trim()) {
    throw new Error('Pairing secret is required (read the 0600 pairing-secret file).');
  }

  const nonceRes = await fetch(`${base}/api/pair`);
  if (!nonceRes.ok) {
    let detail = `Pairing challenge failed: ${nonceRes.status}`;
    try {
      const err = (await nonceRes.json()) as { error?: string };
      if (err.error) detail = err.error;
    } catch {
      /* ignore non-JSON body */
    }
    throw new Error(detail);
  }
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  if (typeof nonce !== 'string' || !nonce) {
    throw new Error('Pairing challenge returned no nonce');
  }

  const hmac = await hmacSha256Hex(secret.trim(), nonce);
  const pairRes = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, hmac, ...(label ? { label } : {}) }),
  });
  if (!pairRes.ok) {
    let detail = `Pairing failed: ${pairRes.status}`;
    try {
      const err = (await pairRes.json()) as { error?: string };
      if (err.error) detail = err.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const { token } = (await pairRes.json()) as { token: string };
  if (typeof token !== 'string' || !token) {
    throw new Error('Pairing succeeded but no token was returned');
  }
  setDaemonUrl(base);
  setDaemonToken(token);
  return token;
}

let rpcId = 1;

const HTTP_RPC_TIMEOUT_MS = 30_000;

/** Make a JSON-RPC call to the daemon's HTTP gateway */
async function httpRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const url = getDaemonUrl();
  if (!url) throw new Error('No daemon URL configured');

  const token = getDaemonToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_RPC_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('The daemon did not respond in time.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('Authentication required. Pair with the daemon first.');
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

function extractInvokeMessage(err: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof err === 'string') {
    const trimmed = err.trim();
    if (trimmed.length > 0 && trimmed !== '[object Object]') return trimmed;
    return null;
  }
  if (err instanceof Error) {
    if (err.message && err.message !== '[object Object]') return err.message;
    return extractInvokeMessage((err as { cause?: unknown }).cause, depth + 1);
  }
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    for (const key of ['message', 'error', 'msg'] as const) {
      const nested = extractInvokeMessage(rec[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Turn a Tauri/IPC reject value into an Error with a readable message. */
export function formatInvokeError(err: unknown): Error {
  if (err instanceof Error && err.message && err.message !== '[object Object]') {
    return err;
  }
  const message = extractInvokeMessage(err);
  return new Error(message ?? 'Studio command failed');
}

/** String form for UI catch sites. Never returns `[object Object]`. */
export function invokeErrorMessage(err: unknown): string {
  return formatInvokeError(err).message;
}

export function isDaemonUnreachable(message: string): boolean {
  return (
    message.startsWith('Relay closed') ||
    message.startsWith('Relay spawn failed:') ||
    message.startsWith('Harness daemon not running') ||
    message.startsWith('The agent daemon in WSL') ||
    message.startsWith('The WSL agent relay') ||
    message.startsWith('The WSL agent did not answer') ||
    message.startsWith('Studio lost the WSL agent relay') ||
    message.startsWith('Studio could not start the WSL agent relay') ||
    message.startsWith('RPC timeout')
  );
}

/** One actionable line. Do not send the operator to Setup for a pipe failure. */
export function formatDaemonUnreachable(message: string): string {
  if (!isDaemonUnreachable(message)) return message;
  if (message.includes('revdev-relay') || message.includes('No such file or directory')) {
    return 'The WSL agent relay is not installed. Connect Agent to install it.';
  }
  if (message.startsWith('Relay spawn failed:') || message.startsWith('Studio could not start')) {
    return 'Studio could not start the WSL agent relay. Connect Agent to try again.';
  }
  if (message.startsWith('Relay closed') || message.startsWith('Studio lost the WSL agent relay')) {
    return 'Studio lost the WSL agent relay. Connect Agent to open it again.';
  }
  if (message.startsWith('RPC timeout') || message.startsWith('The WSL agent did not answer')) {
    return 'The WSL agent did not answer in time. Connect Agent to try again.';
  }
  return 'The agent daemon in WSL is not running. Connect Agent to start it.';
}

/** Guarded invoke — returns mock data in browser, real IPC in Tauri */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Tauri native mode — use IPC
  if (isTauri()) {
    return tauriInvoke<T>(cmd, args).catch((err: unknown) => {
      throw formatInvokeError(err);
    });
  }

  // Browser mode with remote daemon — route harness commands over HTTP
  const rpcMethod = HARNESS_RPC_MAP[cmd];
  if (rpcMethod && getDaemonUrl()) {
    const params = toRpcParams(cmd, args);
    if (cmd === 'harness_ping') {
      return httpRpc<unknown>(rpcMethod, params)
        .then(() => true as T)
        .catch(() => false as T);
    }
    const call = httpRpc<unknown>(rpcMethod, params);
    const adapter = RESULT_ADAPTERS[cmd];
    return (adapter ? call.then(adapter) : call) as Promise<T>;
  }

  // Desktop-only commands with a live daemon configured: reject with a real
  // explanation. Falling through to mock data here would show fabricated
  // agent/inference state alongside real daemon data.
  if (DESKTOP_ONLY_COMMANDS.has(cmd) && getDaemonUrl()) {
    return Promise.reject(
      new Error(
        `${cmd} is only available in the desktop app. The remote daemon has no equivalent RPC yet.`,
      ),
    );
  }

  // Fallback: mock data for non-harness commands. Serving fabricated system
  // state — flag degraded mode so the shell banner stays visible.
  if (cmd in MOCK_DATA) {
    markDegraded('Demo data — showing mocked system state, not a real daemon.');
    return Promise.resolve(MOCK_DATA[cmd] as T);
  }
  return Promise.reject(new Error(`No mock data for command: ${cmd}`));
}

/** Typed wrappers around Tauri invoke calls */

export function getSystemStatus(): Promise<SystemStatus> {
  return invoke<SystemStatus>('get_system_status');
}

export function getMountStatus(): Promise<MountStatus> {
  return invoke<MountStatus>('get_mount_status');
}

/** Planning-board snapshot for Studio Fleet map (typed by caller / fleet-map.ts). */
export function readFleetMapPayload<T>(): Promise<T> {
  return invoke<T>('read_fleet_map');
}

export function mountDevbox(): Promise<string> {
  return invoke<string>('mount_devbox');
}

export function unmountDevbox(): Promise<string> {
  return invoke<string>('unmount_devbox');
}

export function syncAllRepos(): Promise<SyncResult[]> {
  return invoke<SyncResult[]>('sync_all_repos');
}

export function syncRepo(name: string): Promise<SyncResult> {
  return invoke<SyncResult>('sync_repo', { name });
}

export function listApps(): Promise<AppStatus[]> {
  return invoke<AppStatus[]>('list_apps');
}

export function startApp(name: string): Promise<string> {
  return invoke<string>('start_app', { name });
}

export function stopApp(name: string): Promise<string> {
  return invoke<string>('stop_app', { name });
}

export function readAppLog(name: string, lines?: number): Promise<string> {
  return invoke<string>('read_app_log', { name, lines: lines ?? null });
}

export function checkSetup(): Promise<SetupStatus> {
  return invoke<SetupStatus>('check_setup');
}

/** Stage `revdev-relay`, enable the WSL daemon unit, provision this install's trust entry. */
export function daemonSetup(): Promise<string> {
  return invoke<string>('daemon_setup');
}

export function setGitIdentity(name: string, email: string): Promise<void> {
  return invoke<void>('set_git_identity', { name, email });
}

// ── Vault ──────────────────────────────────────────────────────────────────

export function vaultInit(): Promise<void> {
  return invoke<void>('vault_init');
}

export function vaultIsInitialized(): Promise<boolean> {
  return invoke<boolean>('vault_is_initialized');
}

export function vaultList(prefix?: string): Promise<SecretInfo[]> {
  return invoke<SecretInfo[]>('vault_list', { prefix: prefix ?? null });
}

export function vaultGet(path: string): Promise<string> {
  return invoke<string>('vault_get', { path });
}

export function vaultSet(path: string, value: string, force: boolean): Promise<void> {
  return invoke<void>('vault_set', { path, value, force });
}

export function vaultDelete(path: string): Promise<void> {
  return invoke<void>('vault_delete', { path });
}

export function vaultSearch(query: string): Promise<SecretInfo[]> {
  return invoke<SecretInfo[]>('vault_search', { query });
}

export function vaultCopy(value: string): Promise<void> {
  return invoke<void>('vault_copy', { value });
}

// ── SSH Terminal ──────────────────────────────────────────────────────────────

export function sshConnect(params: SshConnectParams): Promise<string> {
  return invoke<string>('ssh_connect', { ...params });
}

export function sshDisconnect(sessionId: string): Promise<void> {
  return invoke<void>('ssh_disconnect', { sessionId });
}

export function sshSend(sessionId: string, data: string): Promise<void> {
  return invoke<void>('ssh_send', { sessionId, data });
}

export function sshResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('ssh_resize', { sessionId, cols, rows });
}

// ── SSH Bookmarks ────────────────────────────────────────────────────────────

export function sshBookmarkList(): Promise<SshBookmark[]> {
  return invoke<SshBookmark[]>('ssh_bookmark_list');
}

export function sshBookmarkSave(bookmark: SshBookmark): Promise<void> {
  return invoke<void>('ssh_bookmark_save', { bookmark });
}

export function sshBookmarkDelete(id: string): Promise<void> {
  return invoke<void>('ssh_bookmark_delete', { id });
}

// ── Local Shell ─────────────────────────────────────────────────────────────

export function shellOpen(cols: number, rows: number, cwd?: string): Promise<string> {
  return invoke<string>('shell_open', {
    cols,
    rows,
    cwd: cwd ?? null,
  });
}

export function shellClose(sessionId: string): Promise<void> {
  return invoke<void>('shell_close', { sessionId });
}

export function shellSend(sessionId: string, data: string): Promise<void> {
  return invoke<void>('shell_send', { sessionId, data });
}

export function shellResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('shell_resize', { sessionId, cols, rows });
}

// ── Git Panel ─────────────────────────────────────────────────────────────

export function gitStatus(repoPath: string): Promise<GitStatusResult> {
  return invoke<GitStatusResult>('git_status', { repoPath });
}

export function gitDiffFile(repoPath: string, filePath: string, staged: boolean): Promise<string> {
  return invoke<string>('git_diff_file', { repoPath, filePath, staged });
}

export function gitDiffContent(
  repoPath: string,
  filePath: string,
  staged: boolean,
): Promise<GitDiffContent> {
  return invoke<GitDiffContent>('git_diff_content', { repoPath, filePath, staged });
}

export function gitStageFile(repoPath: string, filePath: string): Promise<void> {
  return invoke<void>('git_stage_file', { repoPath, filePath });
}

export function gitUnstageFile(repoPath: string, filePath: string): Promise<void> {
  return invoke<void>('git_unstage_file', { repoPath, filePath });
}

export function gitDiscardFile(repoPath: string, filePath: string): Promise<void> {
  return invoke<void>('git_discard_file', { repoPath, filePath });
}

export function gitCommit(repoPath: string, message: string): Promise<string> {
  return invoke<string>('git_commit', { repoPath, message });
}

export function gitListBranches(repoPath: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>('git_list_branches', { repoPath });
}

export function gitCreateBranch(repoPath: string, name: string): Promise<void> {
  return invoke<void>('git_create_branch', { repoPath, name });
}

export function gitSwitchBranch(repoPath: string, name: string): Promise<void> {
  return invoke<void>('git_switch_branch', { repoPath, name });
}

export function gitDeleteBranch(repoPath: string, name: string): Promise<void> {
  return invoke<void>('git_delete_branch', { repoPath, name });
}

export function gitPush(repoPath: string, remote: string, branch: string): Promise<GitPushResult> {
  return invoke<GitPushResult>('git_push', { repoPath, remote, branch });
}

export function gitPull(repoPath: string, remote: string, branch: string): Promise<GitPullResult> {
  return invoke<GitPullResult>('git_pull', { repoPath, remote, branch });
}

export function gitLog(repoPath: string, limit?: number): Promise<GitCommitInfo[]> {
  return invoke<GitCommitInfo[]>('git_log', { repoPath, limit: limit ?? null });
}

export function gitReadFile(repoPath: string, filePath: string): Promise<string> {
  return invoke<string>('git_read_file', { repoPath, filePath });
}

export function gitWriteFile(repoPath: string, filePath: string, content: string): Promise<void> {
  return invoke<void>('git_write_file', { repoPath, filePath, content });
}

// ── Agent Panel ──────────────────────────────────────────────────────────────

export function agentReadWorkboard(path: string): Promise<string> {
  return invoke<string>('agent_read_workboard', { path });
}

// ── Agent Spawner ───────────────────────────────────────────────────────────

export function agentSpawn(
  name: string,
  backend: AgentBackend,
  model: string,
  prompt: string,
  options?: { cwd?: string; cols?: number; rows?: number },
): Promise<string> {
  // Local inference only (Snap/Ollama). Confined agents: harnessAgentSpawn.
  return invoke<string>('agent_spawn', {
    name,
    backend,
    model,
    prompt,
    cwd: options?.cwd ?? null,
    cols: options?.cols ?? null,
    rows: options?.rows ?? null,
  });
}

/** Confined daemon agent.spawn (INIT-002 PW-SPAWN primary path). */
export function harnessAgentSpawn(params: {
  command: string;
  args?: string[];
  repoPath: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}): Promise<HarnessAgentProcess> {
  return invoke<HarnessAgentProcess>('harness_agent_spawn', {
    command: params.command,
    args: params.args ?? [],
    repoPath: params.repoPath,
    cwd: params.cwd ?? null,
    cols: params.cols ?? null,
    rows: params.rows ?? null,
  });
}

export function harnessAgentList(): Promise<HarnessAgentProcess[]> {
  return invoke<HarnessAgentProcess[]>('harness_agent_list');
}

export function harnessAgentStop(processId: string): Promise<void> {
  return invoke<void>('harness_agent_stop', { processId });
}

export function harnessAgentRemove(processId: string): Promise<void> {
  return invoke<void>('harness_agent_remove', { processId });
}

export function agentStop(sessionId: string): Promise<void> {
  return invoke<void>('agent_stop', { sessionId });
}

export function agentList(): Promise<AgentSessionInfo[]> {
  return invoke<AgentSessionInfo[]>('agent_list');
}

export function agentRemove(sessionId: string): Promise<void> {
  return invoke<void>('agent_remove', { sessionId });
}

export function agentInput(sessionId: string, data: string): Promise<void> {
  return invoke<void>('agent_input', { sessionId, data });
}

export function agentResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('agent_resize', { sessionId, cols, rows });
}

// ── Local Inference ─────────────────────────────────────────────────────────

export function inferenceOllamaStatus(): Promise<OllamaStatus> {
  return invoke<OllamaStatus>('inference_ollama_status');
}

export function inferenceOllamaModels(): Promise<OllamaModel[]> {
  return invoke<OllamaModel[]>('inference_ollama_models');
}

export function inferenceOllamaPull(modelName: string): Promise<ModelPullResult> {
  return invoke<ModelPullResult>('inference_ollama_pull', { modelName });
}

export function inferenceOllamaDelete(modelName: string): Promise<void> {
  return invoke<void>('inference_ollama_delete', { modelName });
}

export function inferenceOllamaStart(): Promise<void> {
  return invoke<void>('inference_ollama_start');
}

export function inferenceOllamaStop(): Promise<void> {
  return invoke<void>('inference_ollama_stop');
}

// ── Inference Snaps ─────────────────────────────────────────────────────────

export function inferenceSnapStatus(snapName: string): Promise<SnapStatus> {
  return invoke<SnapStatus>('inference_snap_status', { snapName });
}

export function inferenceSnapList(): Promise<SnapModel[]> {
  return invoke<SnapModel[]>('inference_snap_list');
}

export function inferenceSnapInstall(snapName: string): Promise<ModelPullResult> {
  return invoke<ModelPullResult>('inference_snap_install', { snapName });
}

export function inferenceSnapRemove(snapName: string): Promise<void> {
  return invoke<void>('inference_snap_remove', { snapName });
}

// ── Local AI profile tiers ──────────────────────────────────────────────────

export function inferenceProfileGet(): Promise<LocalAiProfileView> {
  return invoke<LocalAiProfileView>('inference_profile_get');
}

export function inferenceProfileApply(tier: LocalAiTier | string): Promise<LocalAiProfileView> {
  return invoke<LocalAiProfileView>('inference_profile_apply', { tier });
}

// ── Terminal profiles ────────────────────────────────────────────────────────

export function terminalDetect(): Promise<TerminalProfile[]> {
  if (!isTauri()) {
    return Promise.resolve([
      {
        id: 'alacritty',
        name: 'Alacritty',
        platform: 'Linux',
        installed: false,
        config_file: 'alacritty-revealui.toml',
        dest_path: '',
      },
      {
        id: 'kitty',
        name: 'Kitty',
        platform: 'Linux',
        installed: true,
        config_file: 'kitty-revealui.conf',
        dest_path: '',
      },
    ]);
  }
  return invoke<TerminalProfile[]>('terminal_detect');
}

export function terminalInstall(terminalId: string, configDir: string): Promise<TerminalProfile> {
  return invoke<TerminalProfile>('terminal_install', { terminalId, configDir });
}

// ── Launcher (quick-switch) ──────────────────────────────────────────────────

export function focusWindow(processName: string): Promise<boolean> {
  if (!isTauri()) {
    return Promise.resolve(false);
  }
  return invoke<boolean>('focus_window', { processName });
}

// ── Tile gallery (trusted-host process / browser profile discovery) ─────────

export interface BrowserProfileRow {
  directory: string;
  name: string;
  browser: string;
}

export function detectBrowserProfiles(): Promise<BrowserProfileRow[]> {
  return invoke<BrowserProfileRow[]>('detect_browser_profiles');
}

export function listRunningProcesses(): Promise<string[]> {
  return invoke<string[]>('list_running_processes');
}

export function launchAllowedProgram(program: string, args?: string[]): Promise<void> {
  return invoke<void>('launch_allowed_program', {
    program,
    args: args ?? null,
  });
}

// ── Harness Daemon ─────────────────────────────────────────────────────────

export function harnessPing(): Promise<boolean> {
  return invoke<boolean>('harness_ping');
}

export function harnessSessions(): Promise<HarnessSession[]> {
  return invoke<HarnessSession[]>('harness_sessions');
}

export function harnessInbox(agentId: string, unreadOnly: boolean): Promise<HarnessMessage[]> {
  return invoke<HarnessMessage[]>('harness_inbox', { agentId, unreadOnly });
}

export function harnessSendMessage(
  fromAgent: string,
  toAgent: string,
  subject: string,
  body: string,
): Promise<HarnessMessage> {
  return invoke<HarnessMessage>('harness_send_message', { fromAgent, toAgent, subject, body });
}

export function harnessBroadcast(
  fromAgent: string,
  subject: string,
  body: string,
): Promise<number> {
  return invoke<number>('harness_broadcast', { fromAgent, subject, body });
}

export function harnessMarkRead(messageIds: number[]): Promise<void> {
  return invoke<void>('harness_mark_read', { messageIds });
}

export function harnessTasks(status?: string, owner?: string): Promise<HarnessTask[]> {
  return invoke<HarnessTask[]>('harness_tasks', {
    status: status ?? null,
    owner: owner ?? null,
  });
}

export function harnessCreateTask(taskId: string, description: string): Promise<HarnessTask> {
  return invoke<HarnessTask>('harness_create_task', { taskId, description });
}

export function harnessClaimTask(taskId: string, agentId: string): Promise<HarnessClaimResult> {
  return invoke<HarnessClaimResult>('harness_claim_task', { taskId, agentId });
}

export function harnessCompleteTask(taskId: string, agentId: string): Promise<boolean> {
  return invoke<boolean>('harness_complete_task', { taskId, agentId });
}

export function harnessReleaseTask(taskId: string, agentId: string): Promise<boolean> {
  return invoke<boolean>('harness_release_task', { taskId, agentId });
}

/** GAP-362: long-poll until work.completed (or timeout). Prefer over polling tasks.list. */
export function harnessEventsWait(params: {
  eventType: string;
  sinceId?: number;
  timeoutMs?: number;
}): Promise<{ event: Record<string, unknown> | null; timedOut: boolean }> {
  return invoke<{ event: Record<string, unknown> | null; timedOut: boolean }>(
    'harness_events_wait',
    {
      eventType: params.eventType,
      sinceId: params.sinceId ?? 0,
      timeoutMs: params.timeoutMs ?? 30_000,
    },
  );
}

/**
 * GAP-362 adapter: wait for a coordination task completion via events.wait.
 * Prefer this over polling tasks.list. Mirrors @revdev/protocol waitForWorkCompleted
 * over the Studio invoke bridge (no runtime dep on protocol package).
 */
export function harnessWaitForWorkCompleted(params?: {
  sinceId?: number;
  timeoutMs?: number;
}): Promise<{ event: Record<string, unknown> | null; timedOut: boolean }> {
  return harnessEventsWait({
    eventType: 'work.completed',
    sinceId: params?.sinceId ?? 0,
    timeoutMs: params?.timeoutMs ?? 30_000,
  });
}

export function harnessReservations(agentId?: string): Promise<HarnessReservation[]> {
  return invoke<HarnessReservation[]>('harness_reservations', { agentId: agentId ?? null });
}

export function harnessReserveFile(
  filePath: string,
  agentId: string,
  ttlSeconds: number,
  reason: string,
): Promise<HarnessReserveResult> {
  return invoke<HarnessReserveResult>('harness_reserve_file', {
    filePath,
    agentId,
    ttlSeconds,
    reason,
  });
}

export function harnessPermissionPending(agentId?: string): Promise<HarnessApproval[]> {
  return invoke<HarnessApproval[]>('harness_permission_pending', {
    agentId: agentId ?? null,
  });
}

export function harnessPermissionDecide(
  approvalId: string,
  verdict: 'approved' | 'denied',
): Promise<HarnessDecideResult> {
  return invoke<HarnessDecideResult>('harness_permission_decide', {
    approvalId,
    verdict,
  });
}

export function harnessPermissionSetMode(
  agentId: string,
  mode: string | null,
): Promise<HarnessSetModeResult> {
  return invoke<HarnessSetModeResult>('harness_permission_set_mode', {
    agentId,
    mode,
  });
}

export function harnessCheckFile(filePath: string): Promise<HarnessReservation | null> {
  return invoke<HarnessReservation | null>('harness_check_file', { filePath });
}

// ── Daemon Lifecycle ───────────────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  reachable: boolean;
}

export function daemonStatus(): Promise<DaemonStatus> {
  return invoke<DaemonStatus>('daemon_status');
}

export function daemonStart(): Promise<number> {
  return invoke<number>('daemon_start');
}

export function daemonStop(): Promise<void> {
  return invoke<void>('daemon_stop');
}

export function daemonRestart(): Promise<number> {
  return invoke<number>('daemon_restart');
}

// Re-export AgentSession so consumers don't need to reach into types directly
export type { AgentSession };
