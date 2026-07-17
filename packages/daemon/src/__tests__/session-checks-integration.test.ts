/**
 * End-to-end proof that session.register runs the advisory checks and returns
 * their warnings, without ever failing registration on a check error.
 *
 * Spins up a real daemon on a throwaway socket, registers a throwing check and
 * a warning check AFTER startup (startDaemon's initSessionChecks already ran),
 * then calls session.register over the wire.
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

// Daemon startup can take >10s in CI (key generation + socket bind).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../server.js';
import { clearSessionChecks, registerSessionCheck } from '../session-checks/index.js';

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
      const line = buf.slice(0, nl);
      sock.end();
      try {
        const resp = JSON.parse(line);
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

let dataDir: string;
let socketPath: string;
let close: () => Promise<void>;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-session-checks-'));
  socketPath = join(dataDir, 'harness.sock');
  const d = await startDaemon({ socketPath, dataDir });
  close = d.close;
});

afterAll(async () => {
  clearSessionChecks();
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
});

describe('session.register advisory checks', () => {
  it('returns an empty warnings array when no check reports drift', async () => {
    const result = (await rpc(socketPath, 'session.register', {
      agentName: 'clean',
      workDir: '/tmp/clean',
      backend: 'test',
    })) as { sessionId: string; warnings: string[] };

    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.warnings).toEqual([]);
  });

  it('surfaces a warning check in the register response and survives a throwing check', async () => {
    registerSessionCheck('boom', async () => {
      throw new Error('advisory check exploded');
    });
    registerSessionCheck('warn', async (ctx) => ({
      ok: false,
      warnings: [`drift seen in ${ctx.workDir}`],
    }));

    const result = (await rpc(socketPath, 'session.register', {
      agentName: 'drifting',
      workDir: '/tmp/project-root',
      backend: 'test',
    })) as { sessionId: string; warnings: string[] };

    // Registration succeeded despite the throwing check...
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // ...and the healthy check's warning was surfaced.
    expect(result.warnings).toEqual(['drift seen in /tmp/project-root']);
  });
});
