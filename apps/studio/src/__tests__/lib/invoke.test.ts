import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri core invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Simulate non-Tauri environment (no __TAURI_INTERNALS__)
// The invoke.ts module checks for this to decide between mock and real IPC

describe('invoke bridge (browser mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure we're in browser mode (no __TAURI_INTERNALS__)
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getSystemStatus returns mock data in browser mode', async () => {
    const { getSystemStatus } = await import('../../lib/invoke');
    const result = await getSystemStatus();
    expect(result).toHaveProperty('wsl_running');
    expect(result).toHaveProperty('distribution');
    expect(result).toHaveProperty('tier');
    expect(result).toHaveProperty('systemd_status');
  });

  it('getMountStatus returns mock data in browser mode', async () => {
    const { getMountStatus } = await import('../../lib/invoke');
    const result = await getMountStatus();
    expect(result).toHaveProperty('mounted');
    expect(result).toHaveProperty('mount_point');
  });

  it('mountDevbox returns mock string', async () => {
    const { mountDevbox } = await import('../../lib/invoke');
    const result = await mountDevbox();
    expect(typeof result).toBe('string');
  });

  it('unmountDevbox returns mock string', async () => {
    const { unmountDevbox } = await import('../../lib/invoke');
    const result = await unmountDevbox();
    expect(typeof result).toBe('string');
  });

  it('syncAllRepos returns mock array', async () => {
    const { syncAllRepos } = await import('../../lib/invoke');
    const result = await syncAllRepos();
    expect(Array.isArray(result)).toBe(true);
  });

  it('syncRepo returns mock SyncResult', async () => {
    const { syncRepo } = await import('../../lib/invoke');
    const result = await syncRepo('RevealUI');
    expect(result).toHaveProperty('drive');
    expect(result).toHaveProperty('repo');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('branch');
  });

  it('listApps returns mock app list', async () => {
    const { listApps } = await import('../../lib/invoke');
    const result = await listApps();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('app');
    expect(result[0]).toHaveProperty('running');
  });

  it('startApp returns mock string', async () => {
    const { startApp } = await import('../../lib/invoke');
    const result = await startApp('api');
    expect(typeof result).toBe('string');
  });

  it('stopApp returns mock string', async () => {
    const { stopApp } = await import('../../lib/invoke');
    const result = await stopApp('api');
    expect(typeof result).toBe('string');
  });

  it('readAppLog returns mock string', async () => {
    const { readAppLog } = await import('../../lib/invoke');
    const result = await readAppLog('api');
    expect(typeof result).toBe('string');
  });

  it('checkSetup returns mock SetupStatus', async () => {
    const { checkSetup } = await import('../../lib/invoke');
    const result = await checkSetup();
    expect(result).toHaveProperty('wsl_running');
    expect(result).toHaveProperty('nix_installed');
    expect(result).toHaveProperty('devbox_mounted');
    expect(result).toHaveProperty('git_name');
    expect(result).toHaveProperty('git_email');
  });

  it('setGitIdentity resolves void', async () => {
    const { setGitIdentity } = await import('../../lib/invoke');
    await expect(setGitIdentity('Test', 'test@example.com')).resolves.toBeUndefined();
  });

  it('vaultInit resolves void', async () => {
    const { vaultInit } = await import('../../lib/invoke');
    await expect(vaultInit()).resolves.toBeUndefined();
  });

  it('vaultIsInitialized returns boolean', async () => {
    const { vaultIsInitialized } = await import('../../lib/invoke');
    const result = await vaultIsInitialized();
    expect(typeof result).toBe('boolean');
  });

  it('vaultList returns mock secret list', async () => {
    const { vaultList } = await import('../../lib/invoke');
    const result = await vaultList();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('path');
    expect(result[0]).toHaveProperty('namespace');
  });

  it('vaultGet returns mock string', async () => {
    const { vaultGet } = await import('../../lib/invoke');
    const result = await vaultGet('stripe/secret_key');
    expect(typeof result).toBe('string');
  });

  it('vaultSet resolves void', async () => {
    const { vaultSet } = await import('../../lib/invoke');
    await expect(vaultSet('test/key', 'value', false)).resolves.toBeUndefined();
  });

  it('vaultDelete resolves void', async () => {
    const { vaultDelete } = await import('../../lib/invoke');
    await expect(vaultDelete('test/key')).resolves.toBeUndefined();
  });

  it('vaultSearch returns empty array', async () => {
    const { vaultSearch } = await import('../../lib/invoke');
    const result = await vaultSearch('query');
    expect(Array.isArray(result)).toBe(true);
  });

  it('vaultCopy resolves void', async () => {
    const { vaultCopy } = await import('../../lib/invoke');
    await expect(vaultCopy('secret')).resolves.toBeUndefined();
  });

  it('sshConnect returns mock session id', async () => {
    const { sshConnect } = await import('../../lib/invoke');
    const result = await sshConnect({
      host: 'example.com',
      port: 22,
      username: 'user',
      auth: { method: 'password', password: 'pass' },
    });
    expect(typeof result).toBe('string');
  });

  it('sshDisconnect resolves void', async () => {
    const { sshDisconnect } = await import('../../lib/invoke');
    await expect(sshDisconnect('session-1')).resolves.toBeUndefined();
  });

  it('sshSend resolves void', async () => {
    const { sshSend } = await import('../../lib/invoke');
    await expect(sshSend('session-1', 'ls\n')).resolves.toBeUndefined();
  });

  it('sshResize resolves void', async () => {
    const { sshResize } = await import('../../lib/invoke');
    await expect(sshResize('session-1', 80, 24)).resolves.toBeUndefined();
  });

  it('sshBookmarkList returns empty array', async () => {
    const { sshBookmarkList } = await import('../../lib/invoke');
    const result = await sshBookmarkList();
    expect(Array.isArray(result)).toBe(true);
  });

  it('sshBookmarkSave resolves void', async () => {
    const { sshBookmarkSave } = await import('../../lib/invoke');
    await expect(
      sshBookmarkSave({
        id: '1',
        label: 'test',
        host: 'host',
        port: 22,
        username: 'user',
        auth_method: 'key',
        key_path: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('sshBookmarkDelete resolves void', async () => {
    const { sshBookmarkDelete } = await import('../../lib/invoke');
    await expect(sshBookmarkDelete('1')).resolves.toBeUndefined();
  });
});

describe('invoke bridge (Tauri mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Simulate Tauri environment
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('delegates to tauri invoke in Tauri mode', async () => {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    vi.mocked(tauriInvoke).mockResolvedValue({
      wsl_running: true,
      distribution: 'Ubuntu',
      tier: 'pro',
      systemd_status: 'running',
    });

    const { getSystemStatus } = await import('../../lib/invoke');
    const result = await getSystemStatus();
    expect(tauriInvoke).toHaveBeenCalledWith('get_system_status', undefined);
    expect(result.wsl_running).toBe(true);
  });
});

describe('HARNESS_RPC_MAP contract', () => {
  it('routes every command to a method the daemon actually registers', async () => {
    const { HARNESS_RPC_MAP } = await import('../../lib/invoke');
    const { RPC_METHODS } = await import('@revdev/protocol');
    const known = new Set<string>(Object.values(RPC_METHODS));

    const unknownTargets = Object.entries(HARNESS_RPC_MAP)
      .filter(([, method]) => !known.has(method))
      .map(([command, method]) => `${command} -> ${method}`)
      .sort();

    expect(
      unknownTargets,
      `HARNESS_RPC_MAP targets methods absent from RPC_METHODS: ${JSON.stringify(unknownTargets)}`,
    ).toEqual([]);
  });
});

// Browser mode routes the newly-wired commands over the daemon HTTP gateway and
// adapts each daemon result back to the Studio type. These drive the real
// invoke() path with a mocked fetch so the mapping, param rename, and result
// adapters are all exercised end to end.
describe('browser-mode daemon adapters', () => {
  const DAEMON_URL = 'https://daemon.test';

  /** A fetch stub returning a JSON-RPC success envelope wrapping `result`. */
  function rpcOk(result: unknown): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result }),
    } as unknown as Response);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    localStorage.setItem('revdev-daemon-url', DAEMON_URL);
    localStorage.setItem('revdev-daemon-token', 'test-token');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adapts inference.status into OllamaStatus', async () => {
    vi.stubGlobal(
      'fetch',
      rpcOk({ running: true, version: '0.1.30', url: 'http://localhost:11434', models: [] }),
    );
    const { inferenceOllamaStatus } = await import('../../lib/invoke');
    const status = await inferenceOllamaStatus();
    expect(status).toEqual({ installed: true, running: true, version: '0.1.30' });
  });

  it('adapts inference.status models into OllamaModel[] with a formatted size', async () => {
    vi.stubGlobal(
      'fetch',
      rpcOk({
        running: true,
        version: '0.1.30',
        models: [{ name: 'llama3:8b', sizeMb: 4700, modified: '2026-01-01' }],
      }),
    );
    const { inferenceOllamaModels } = await import('../../lib/invoke');
    const models = await inferenceOllamaModels();
    expect(models).toEqual([{ name: 'llama3:8b', size: '4.7 GB', modified: '2026-01-01' }]);
  });

  it('renames modelName to model and adapts inference.pull into ModelPullResult', async () => {
    const fetchMock = rpcOk({ success: true, model: 'llama3', status: 'success' });
    vi.stubGlobal('fetch', fetchMock);
    const { inferenceOllamaPull } = await import('../../lib/invoke');
    const result = await inferenceOllamaPull('llama3');
    expect(result).toEqual({ success: true, message: 'success' });
    // The daemon schema requires `model`, not the wrapper's `modelName`.
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.params).toEqual({ model: 'llama3' });
    expect(body.method).toBe('inference.pull');
  });

  it('adapts agent.list rows into AgentSessionInfo with a null backend', async () => {
    vi.stubGlobal(
      'fetch',
      rpcOk([
        {
          processId: 'p1',
          command: 'bash',
          cwd: '/repo',
          pid: 42,
          status: 'running',
          exitCode: null,
        },
        {
          processId: 'p2',
          command: 'node',
          cwd: '/repo',
          pid: null,
          status: 'exited',
          exitCode: 1,
        },
      ]),
    );
    const { agentList } = await import('../../lib/invoke');
    const sessions = await agentList();
    expect(sessions).toEqual([
      { id: 'p1', name: 'bash', model: '', backend: null, prompt: '', status: 'running', pid: 42 },
      {
        id: 'p2',
        name: 'node',
        model: '',
        backend: null,
        prompt: '',
        status: 'errored',
        pid: null,
      },
    ]);
  });
});
