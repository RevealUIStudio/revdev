/**
 * GAP-362 — work.completed notify + loop guard RPCs.
 * @vitest-environment node
 */
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../server.js';
import { validateParams } from '../validation/index.js';
import { WORK_COMPLETED_EVENT } from '../work-events.js';

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
    sock.setTimeout(15_000, () => {
      sock.destroy();
      reject(new Error(`RPC timeout: ${method}`));
    });
  });
}

function rpcAgent(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return rpc(socketPath, method, { ...params, actorAgentId: 'tok-alice' });
}

let dataDir: string;
let socketPath: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-tok-'));
  socketPath = join(dataDir, 'harness.sock');
  const d = await startDaemon({ socketPath, dataDir });
  close = d.close;
  await rpc(socketPath, 'session.register', {
    agentId: 'tok-alice',
    agentName: 'tok-alice',
    task: 'GAP-362',
  });
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  const { clearTestLicenseEnv } = await import('./test-license-helper.js');
  clearTestLicenseEnv();
});

describe('GAP-362 schemas', () => {
  it('accepts loop.arm and events.wait shapes', () => {
    expect(validateParams('loop.arm', { loopId: 'L', intervalMs: 120_000 }).valid).toBe(true);
    expect(
      validateParams('events.wait', { eventType: WORK_COMPLETED_EVENT, timeoutMs: 500 }).valid,
    ).toBe(true);
  });
});

describe('GAP-362 work.completed + loop guard', () => {
  it('emits work.completed on tasks.complete and events.wait receives it', async () => {
    await rpcAgent(socketPath, 'tasks.create', { taskId: 't-362', description: 'done soon' });
    await rpcAgent(socketPath, 'tasks.claim', { taskId: 't-362' });

    const waitP = rpcAgent(socketPath, 'events.wait', {
      eventType: WORK_COMPLETED_EVENT,
      sinceId: 0,
      timeoutMs: 5_000,
    });

    // complete slightly after wait starts
    await new Promise((r) => setTimeout(r, 50));
    const done = (await rpcAgent(socketPath, 'tasks.complete', {
      taskId: 't-362',
      summary: 'shipped',
    })) as { ok: boolean };
    expect(done.ok).toBe(true);

    const waited = (await waitP) as {
      timedOut: boolean;
      event: { event_type?: string; eventType?: string; payload: unknown } | null;
    };
    expect(waited.timedOut).toBe(false);
    expect(waited.event).not.toBeNull();

    const q = (await rpcAgent(socketPath, 'events.query', {
      eventType: WORK_COMPLETED_EVENT,
      limit: 5,
    })) as { events: Array<{ event_type: string }> };
    expect(q.events.some((e) => e.event_type === WORK_COMPLETED_EVENT)).toBe(true);
  });

  it('loop.tick signals not_advancing after noop limit', async () => {
    const armed = (await rpcAgent(socketPath, 'loop.arm', {
      loopId: 'loop-362',
      intervalMs: 5_000,
      noopLimit: 2,
    })) as { loop: { cadenceWarning: string | null; status: string } };
    expect(armed.loop.cadenceWarning).toMatch(/under/);
    expect(armed.loop.status).toBe('armed');

    await rpcAgent(socketPath, 'loop.tick', { loopId: 'loop-362', advanced: false });
    const third = (await rpcAgent(socketPath, 'loop.tick', {
      loopId: 'loop-362',
      advanced: false,
    })) as { loop: { status: string; lastSignal: string | null } };
    expect(third.loop.status).toBe('not_advancing');
    expect(third.loop.lastSignal).toMatch(/not advancing/);

    const stopped = (await rpcAgent(socketPath, 'loop.stop', {
      loopId: 'loop-362',
    })) as { loop: { status: string } };
    expect(stopped.loop.status).toBe('stopped');
  });

  it('loop.tick + loop.spend accumulate token spend', async () => {
    await rpcAgent(socketPath, 'loop.arm', {
      loopId: 'loop-spend',
      intervalMs: 120_000,
    });
    await rpcAgent(socketPath, 'loop.tick', {
      loopId: 'loop-spend',
      advanced: true,
      tokensIn: 100,
      tokensOut: 50,
      costMicros: 1_000,
    });
    await rpcAgent(socketPath, 'loop.record_spend', {
      loopId: 'loop-spend',
      tokensIn: 10,
      tokensOut: 5,
      costMicros: 100,
    });
    const spent = (await rpcAgent(socketPath, 'loop.spend', {
      loopId: 'loop-spend',
    })) as {
      spend: { tokensIn: number; tokensOut: number; costMicros: number };
      tickCount: number;
    };
    expect(spent.spend).toEqual({ tokensIn: 110, tokensOut: 55, costMicros: 1_100 });
    expect(spent.tickCount).toBe(1);

    const status = (await rpcAgent(socketPath, 'loop.status', {
      loopId: 'loop-spend',
    })) as { loop: { spend: { tokensIn: number } } };
    expect(status.loop.spend.tokensIn).toBe(110);

    const q = (await rpcAgent(socketPath, 'events.query', {
      eventType: 'loop.spend_delta',
      limit: 10,
    })) as { events: Array<{ event_type: string }> };
    expect(q.events.some((e) => e.event_type === 'loop.spend_delta')).toBe(true);
  });
});
