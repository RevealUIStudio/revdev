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
      {
        id: 'p1',
        name: 'bash',
        model: '',
        backend: null,
        prompt: '',
        status: 'running',
        pid: 42,
        harness: true,
      },
      {
        id: 'p2',
        name: 'node',
        model: '',
        backend: null,
        prompt: '',
        status: 'errored',
        pid: null,
        harness: true,
      },
    ]);
  });
});

describe('pairWithDaemon (GAP-397 challenge-response)', () => {
  const base = 'http://127.0.0.1:8787';
  const secret = 'a'.repeat(64); // 32-byte secret as hex (UTF-8 key material)
  const nonce = 'b'.repeat(64);
  const token = 'c'.repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('refuses the retired 6-digit code body shape (POST {code} never succeeds)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pair') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        // Gateway rejects missing nonce/hmac
        if (!('nonce' in body) || !('hmac' in body)) {
          return new Response(JSON.stringify({ error: 'nonce and hmac are required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Legacy call shape: second arg was a 6-digit code string — type system no longer
    // allows it; prove the wire contract rejects {code} if somehow posted.
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string };
    expect(err.error).toMatch(/nonce and hmac/i);
  });

  it('completes GET nonce → HMAC → POST and stores bearer token', async () => {
    const { hmacSha256Hex, pairWithDaemon, getDaemonToken, getDaemonUrl } = await import(
      '../../lib/invoke'
    );
    const expectedHmac = await hmacSha256Hex(secret, nonce);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/api/pair` && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ nonce, expiresIn: 120 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === `${base}/api/pair` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as {
          nonce?: string;
          hmac?: string;
          label?: string;
        };
        expect(body.nonce).toBe(nonce);
        expect(body.hmac).toBe(expectedHmac);
        expect(body.label).toBe('studio');
        // Prove we never send a pairing code
        expect(body).not.toHaveProperty('code');
        return new Response(
          JSON.stringify({ token, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const got = await pairWithDaemon({ daemonUrl: base, secret, label: 'studio' });
    expect(got).toBe(token);
    expect(getDaemonToken()).toBe(token);
    expect(getDaemonUrl()).toBe(base);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces gateway errors from a failed HMAC response', async () => {
    const { pairWithDaemon } = await import('../../lib/invoke');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/pair') && (!init?.method || init.method === 'GET')) {
          return new Response(JSON.stringify({ nonce, expiresIn: 120 }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ error: 'Invalid pairing response' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    await expect(pairWithDaemon({ daemonUrl: base, secret })).rejects.toThrow(
      /Invalid pairing response/,
    );
    expect(localStorage.getItem('revdev-daemon-token')).toBeNull();
  });
});

describe('formatInvokeError', () => {
  it('keeps a real Error', async () => {
    const { formatInvokeError } = await import('../../lib/invoke');
    const err = new Error('already an error');
    expect(formatInvokeError(err)).toBe(err);
  });

  it('unwraps StudioError { kind, message }', async () => {
    const { invokeErrorMessage } = await import('../../lib/invoke');
    expect(invokeErrorMessage({ kind: 'Other', message: 'git status failed' })).toBe(
      'git status failed',
    );
  });

  it('unwraps a nested Tauri { message: StudioError } envelope', async () => {
    const { invokeErrorMessage } = await import('../../lib/invoke');
    expect(
      invokeErrorMessage({
        message: { kind: 'Process', message: 'Relay closed without response' },
      }),
    ).toBe('Relay closed without response');
  });

  it('never renders [object Object]', async () => {
    const { invokeErrorMessage } = await import('../../lib/invoke');
    expect(invokeErrorMessage({ kind: 'Io' })).toBe('Studio command failed');
    expect(invokeErrorMessage({})).toBe('Studio command failed');
  });

  it('rewrites relay/daemon failures into a Connect Agent line', async () => {
    const { formatDaemonUnreachable, isDaemonUnreachable } = await import('../../lib/invoke');
    expect(isDaemonUnreachable('Relay closed without response')).toBe(true);
    expect(formatDaemonUnreachable('Relay closed without response')).toBe(
      'Studio lost the WSL agent relay. Connect Agent to open it again.',
    );
    expect(formatDaemonUnreachable('Relay spawn failed: WslLaunch HRESULT 0x80070002')).toBe(
      'Studio could not start the WSL agent relay. Connect Agent to try again.',
    );
    expect(formatDaemonUnreachable('RPC timeout after 10s: ping')).toBe(
      'The WSL agent did not answer in time. Connect Agent to try again.',
    );
    expect(formatDaemonUnreachable('Harness daemon not running')).toBe(
      'The agent daemon in WSL is not running. Connect Agent to start it.',
    );
    expect(
      formatDaemonUnreachable(
        'Relay closed without response. (revdev-relay: connect /home/x/.local/share/revealui/harness.sock: No such file or directory)',
      ),
    ).toBe('The WSL agent relay is not installed. Connect Agent to install it.');
    expect(formatDaemonUnreachable('permission denied')).toBe('permission denied');
  });
});

describe('invoke bridge (Tauri reject payload)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('throws Error.message from a StudioError object reject', async () => {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    vi.mocked(tauriInvoke).mockRejectedValue({
      kind: 'Other',
      message: 'Relay closed without response',
    });

    const { gitStatus } = await import('../../lib/invoke');
    await expect(gitStatus('/repo')).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error && err.message === 'Relay closed without response';
    });
  });
});
