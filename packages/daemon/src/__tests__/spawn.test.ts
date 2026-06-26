/**
 * Unit tests for the agent.* PTY spawn handler group (spawn.ts).
 *
 * node-pty is mocked so no real processes are spawned. Tests drive the
 * daemon via a real Unix socket (same pattern as coordination.test.ts) so
 * the full dispatch + schema validation + identity gate stack is exercised.
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ---------------------------------------------------------------------------
// Mock node-pty BEFORE any module that imports spawn.ts resolves
// ---------------------------------------------------------------------------

interface MockPty {
  pid: number;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  _fireData: (chunk: string) => void;
  _fireExit: (code: number) => void;
}

let _lastPty: MockPty | null = null;
let _pidCounter = 1000;

function makeMockPty(): MockPty {
  let dataCallback: ((chunk: string) => void) | null = null;
  let exitCallback: ((ev: { exitCode: number }) => void) | null = null;

  const pty: MockPty = {
    pid: ++_pidCounter,
    onData: vi.fn((cb: (chunk: string) => void) => {
      dataCallback = cb;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (ev: { exitCode: number }) => void) => {
      exitCallback = cb;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _fireData: (chunk) => dataCallback?.(chunk),
    _fireExit: (code) => exitCallback?.({ exitCode: code }),
  };
  return pty;
}

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    _lastPty = makeMockPty();
    return _lastPty;
  }),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises stat so cwd validation passes for /tmp paths
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(async (p: string) => {
      if (p === '/tmp' || (p.startsWith('/tmp/') && !p.includes('nonexistent'))) {
        return { isDirectory: () => true };
      }
      const err = Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), {
        code: 'ENOENT',
      });
      throw err;
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon } from '../server.js';
// Side-effect import: registers agent.* handlers with the daemon's handler Map.
// Must be imported here (not via index.ts / cli.ts entrypoints) since tests
// import startDaemon directly from server.js. Vitest hoists vi.mock() above
// all static imports, so the node-pty mock is in place before spawn.ts loads.
import '../spawn.js';
import {
  clearTestLicenseEnv,
  generateTestLicense,
  setTestLicenseEnv,
} from './test-license-helper.js';

// ---------------------------------------------------------------------------
// JSON-RPC client helper — one request per socket (stateless)
// ---------------------------------------------------------------------------

function rpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    let buf = '';
    const req = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`;
    sock.on('connect', () => sock.write(req));
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      sock.end();
      try {
        const resp = JSON.parse(buf.slice(0, nl)) as {
          result?: unknown;
          error?: { code: number; message: string };
        };
        if (resp.error) reject(new Error(`${resp.error.code}: ${resp.error.message}`));
        else resolve(resp.result);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    sock.on('error', reject);
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error(`RPC timeout: ${method}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dataDir: string;
let socketPath: string;
let close: () => Promise<void>;
let agentId: string;

beforeAll(async () => {
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-spawn-test-'));
  socketPath = join(dataDir, 'harness.sock');
  const d = await startDaemon({ socketPath, dataDir });
  close = d.close;
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  clearTestLicenseEnv();
});

beforeEach(async () => {
  const r = (await rpc(socketPath, 'session.register', {
    agentName: 'spawn-test-agent',
    workDir: '/tmp',
    backend: 'test',
  })) as { sessionId: string };
  agentId = r.sessionId;
  _lastPty = null;
  _pidCounter = 1000;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent.spawn', () => {
  it('returns a processId (UUID) and numeric pid', async () => {
    const result = (await rpc(socketPath, 'agent.spawn', {
      actorAgentId: agentId,
      command: 'bash',
      args: ['-i'],
      cwd: '/tmp',
    })) as { processId: string; pid: number };

    expect(result.processId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof result.pid).toBe('number');
    expect(result.pid).toBeGreaterThan(0);
  });

  it('rejects when command is missing (schema validation)', async () => {
    await expect(
      rpc(socketPath, 'agent.spawn', {
        actorAgentId: agentId,
        cwd: '/tmp',
      }),
    ).rejects.toThrow();
  });

  it('rejects a nonexistent cwd', async () => {
    await expect(
      rpc(socketPath, 'agent.spawn', {
        actorAgentId: agentId,
        command: 'bash',
        cwd: '/tmp/nonexistent/does-not-exist',
      }),
    ).rejects.toThrow();
  });
});

describe('agent.input', () => {
  it('writes data to the mocked pty', async () => {
    const { processId } = (await rpc(socketPath, 'agent.spawn', {
      actorAgentId: agentId,
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const result = await rpc(socketPath, 'agent.input', {
      actorAgentId: agentId,
      processId,
      data: 'echo hello\n',
    });

    expect(result).toEqual({ written: true });
    expect(_lastPty?.write).toHaveBeenCalledWith('echo hello\n');
  });

  it('rejects input to a process owned by another agent', async () => {
    const { processId } = (await rpc(socketPath, 'agent.spawn', {
      actorAgentId: agentId,
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const other = (await rpc(socketPath, 'session.register', {
      agentName: 'input-other',
      workDir: '/tmp',
      backend: 'test',
    })) as { sessionId: string };

    await expect(
      rpc(socketPath, 'agent.input', {
        actorAgentId: other.sessionId,
        processId,
        data: 'whoami\n',
      }),
    ).rejects.toThrow(/not owned by caller/);
  });
});

describe('agent.resize', () => {
  it('calls pty.resize with the given dimensions', async () => {
    const { processId } = (await rpc(socketPath, 'agent.spawn', {
      actorAgentId: agentId,
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const result = (await rpc(socketPath, 'agent.resize', {
      actorAgentId: agentId,
      processId,
      cols: 120,
      rows: 40,
    })) as { resized: boolean; cols: number; rows: number };

    expect(result.resized).toBe(true);
    expect(result.cols).toBe(120);
    expect(result.rows).toBe(40);
    expect(_lastPty?.resize).toHaveBeenCalledWith(120, 40);
  });

  it('rejects resize for a process owned by another agent', async () => {
    const { processId } = (await rpc(socketPath, 'agent.spawn', {
      actorAgentId: agentId,
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const other = (await rpc(socketPath, 'session.register', {
      agentName: 'resize-other',
      workDir: '/tmp',
      backend: 'test',
    })) as { sessionId: string };

    await expect(
      rpc(socketPath, 'agent.resize', {
        actorAgentId: other.sessionId,
        processId,
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(/not owned by caller/);
  });
});

describe('agent.stop', () => {
  it('kills the mocked pty and returns status killed', async () => {
    const { processId } = (await rpc(socketPath, 'agent.spawn', {
      actorAgentId: agentId,
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const result = (await rpc(socketPath, 'agent.stop', {
      actorAgentId: agentId,
      processId,
    })) as { stopped: string; status: string };

    expect(result.stopped).toBe(processId);
    expect(result.status).toBe('killed');
    expect(_lastPty?.kill).toHaveBeenCalled();
  });

  it('rejects stop for a process owned by another agent', async () => {
    const { processId } = (await rpc(socketPath, 'agent.spawn', {
      actorAgentId: agentId,
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const other = (await rpc(socketPath, 'session.register', {
      agentName: 'stop-other',
      workDir: '/tmp',
      backend: 'test',
    })) as { sessionId: string };

    await expect(
      rpc(socketPath, 'agent.stop', {
        actorAgentId: other.sessionId,
        processId,
      }),
    ).rejects.toThrow(/not owned by caller/);
  });

  it('rejects stop for an unknown processId', async () => {
    await expect(
      rpc(socketPath, 'agent.stop', {
        actorAgentId: agentId,
        processId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/unknown processId/);
  });
});

describe('agent.output', () => {
  it('returns buffered chunks and a cursor', async () => {
    const { processId } = (await rpc(socketPath, 'agent.spawn', {
      actorAgentId: agentId,
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    _lastPty?._fireData('hello world\r\n');

    // Allow the async DB write from bufferOutput to land
    await new Promise((r) => setTimeout(r, 100));

    const result = (await rpc(socketPath, 'agent.output', {
      actorAgentId: agentId,
      processId,
      cursor: '0',
    })) as {
      chunks: Array<{ id: string; seq: number; chunk: string }>;
      cursor: string;
      status: string;
    };

    expect(result.status).toBe('running');
    expect(Array.isArray(result.chunks)).toBe(true);
    if (result.chunks.length > 0) {
      expect(result.chunks[0]?.chunk).toBe('hello world\r\n');
    }
    expect(typeof result.cursor).toBe('string');
  });

  it('rejects output poll for a process owned by another agent', async () => {
    const { processId } = (await rpc(socketPath, 'agent.spawn', {
      actorAgentId: agentId,
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const other = (await rpc(socketPath, 'session.register', {
      agentName: 'output-other',
      workDir: '/tmp',
      backend: 'test',
    })) as { sessionId: string };

    await expect(
      rpc(socketPath, 'agent.output', {
        actorAgentId: other.sessionId,
        processId,
        cursor: '0',
      }),
    ).rejects.toThrow(/not owned by caller/);
  });

  it('rejects output poll for an unknown processId', async () => {
    await expect(
      rpc(socketPath, 'agent.output', {
        actorAgentId: agentId,
        processId: '00000000-0000-0000-0000-000000000001',
        cursor: '0',
      }),
    ).rejects.toThrow(/unknown processId/);
  });
});
