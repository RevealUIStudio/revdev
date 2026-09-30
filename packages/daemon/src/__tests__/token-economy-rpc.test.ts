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
import { parseDid } from '@revdev/protocol/did';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateNonce,
  hashParams,
  serializeEnvelope,
  signEnvelope,
} from '../agent-identity-crypto.js';
import { startDaemon } from '../server.js';
import { validateParams } from '../validation/index.js';
import { WORK_COMPLETED_EVENT } from '../work-events.js';

function rpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  signature?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    let buf = '';
    const frame: Record<string, unknown> = { jsonrpc: '2.0', id: 1, method, params };
    if (signature) frame['x-revdev-signature'] = signature;
    const req = `${JSON.stringify(frame)}\n`;
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
      validateParams('loop.arm', { loopId: 'L', intervalMs: 120_000, sessionId: 'agent-1' }).valid,
    ).toBe(true);
    expect(
      validateParams('events.wait', { eventType: WORK_COMPLETED_EVENT, timeoutMs: 500 }).valid,
    ).toBe(true);
    expect(validateParams('loop.tick', { loopId: 'L', advanced: false }).valid).toBe(true);
    expect(validateParams('loop.tick', { loopId: 'L' }).valid).toBe(false);
    expect(validateParams('loop.status', { loopId: 'L' }).valid).toBe(true);
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
    })) as { loop: { spend: { tokensIn: number } }; stop: boolean };
    expect(status.loop.spend.tokensIn).toBe(110);
    expect(status.stop).toBe(false);

    const q = (await rpcAgent(socketPath, 'events.query', {
      eventType: 'loop.spend_delta',
      limit: 10,
    })) as { events: Array<{ event_type: string }> };
    expect(q.events.some((e) => e.event_type === 'loop.spend_delta')).toBe(true);
  });

  it('applies the default noop limit of 3 and counts every tick', async () => {
    const armed = (await rpcAgent(socketPath, 'loop.arm', {
      loopId: 'loop-default',
      intervalMs: 120_000,
    })) as {
      loop: { noopLimit: number; status: string; sessionId: string; tickCount: number };
      stop: boolean;
      noopLimit: number;
    };
    expect(armed.loop.noopLimit).toBe(3);
    expect(armed.noopLimit).toBe(3);
    expect(armed.stop).toBe(false);
    expect(armed.loop.sessionId).toBe('tok-alice');
    expect(armed.loop.status).toBe('armed');

    const first = (await rpcAgent(socketPath, 'loop.tick', {
      loopId: 'loop-default',
      advanced: false,
    })) as { loop: { status: string; tickCount: number; consecutiveNoOps: number }; stop: boolean };
    expect(first.stop).toBe(false);
    expect(first.loop.status).toBe('armed');
    expect(first.loop.tickCount).toBe(1);
    expect(first.loop.consecutiveNoOps).toBe(1);

    await rpcAgent(socketPath, 'loop.tick', { loopId: 'loop-default', advanced: false });
    const third = (await rpcAgent(socketPath, 'loop.tick', {
      loopId: 'loop-default',
      advanced: false,
    })) as { loop: { status: string; tickCount: number; consecutiveNoOps: number }; stop: boolean };
    expect(third.stop).toBe(true);
    expect(third.loop.status).toBe('not_advancing');
    expect(third.loop.tickCount).toBe(3);
    expect(third.loop.consecutiveNoOps).toBe(3);

    // The limit does not swallow later ticks.
    const fourth = (await rpcAgent(socketPath, 'loop.tick', {
      loopId: 'loop-default',
      advanced: false,
    })) as { loop: { status: string; tickCount: number }; stop: boolean };
    expect(fourth.stop).toBe(true);
    expect(fourth.loop.tickCount).toBe(4);
    expect(fourth.loop.status).toBe('not_advancing');

    // Schema rejects a tick that omits advanced (-32602). It is not counted.
    await expect(rpcAgent(socketPath, 'loop.tick', { loopId: 'loop-default' })).rejects.toThrow(
      /Invalid params/,
    );
    const held = (await rpcAgent(socketPath, 'loop.status', {
      loopId: 'loop-default',
    })) as { loop: { tickCount: number } };
    expect(held.loop.tickCount).toBe(4);
    await expect(
      rpcAgent(socketPath, 'loop.tick', { loopId: 'loop-missing', advanced: true }),
    ).rejects.toThrow(/unknown loopId/);
  });

  it('rejects a loop attached to someone else and a takeover of a live loop id', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'loop-bob',
      agentName: 'loop-bob',
      task: 'peer',
    });
    await rpcAgent(socketPath, 'loop.arm', {
      loopId: 'loop-owned',
      intervalMs: 120_000,
    });
    await expect(
      rpcAgent(socketPath, 'loop.arm', {
        loopId: 'loop-foreign-session',
        intervalMs: 120_000,
        sessionId: 'loop-bob',
      }),
    ).rejects.toThrow(/does not belong/);
    await expect(
      rpc(socketPath, 'loop.arm', {
        loopId: 'loop-owned',
        intervalMs: 120_000,
        actorAgentId: 'loop-bob',
      }),
    ).rejects.toThrow(/owned by another agent/);
    await expect(
      rpc(socketPath, 'loop.tick', {
        loopId: 'loop-owned',
        advanced: false,
        actorAgentId: 'loop-bob',
      }),
    ).rejects.toThrow(/owned by another agent/);
  });

  it('reaps session-attached loops on session.end and leaves peers', async () => {
    const registered = (await rpc(socketPath, 'session.register', {
      agentId: 'loop-reap-a',
      agentName: 'loop-reap-a',
      task: 'reap',
    })) as { did: string; privateKeyPem?: string };
    const parsed = parseDid(registered.did);
    if (!parsed || !registered.privateKeyPem) {
      throw new Error('session.register did not bootstrap a signing key');
    }
    const sign = (method: string, params: Record<string, unknown>): string =>
      serializeEnvelope(
        signEnvelope(
          {
            did: registered.did,
            kid: parsed.fingerprint,
            nonce: generateNonce(),
            ts: Math.floor(Date.now() / 1000),
            method,
            paramsHash: hashParams(method, params),
          },
          registered.privateKeyPem as string,
        ),
      );

    await rpc(socketPath, 'loop.arm', {
      loopId: 'loop-reap-mine',
      intervalMs: 120_000,
      actorAgentId: 'loop-reap-a',
    });
    // Peer loop that must survive this session end.
    await rpcAgent(socketPath, 'loop.arm', {
      loopId: 'loop-reap-peer',
      intervalMs: 120_000,
    });

    const endParams = { summary: 'reap loops' };
    await rpc(socketPath, 'session.end', endParams, sign('session.end', endParams));

    const gone = (await rpc(socketPath, 'loop.status', {
      loopId: 'loop-reap-mine',
      actorAgentId: 'loop-reap-a',
    })) as { loop: unknown; stop: boolean };
    expect(gone.loop).toBeNull();
    expect(gone.stop).toBe(false);
    await expect(
      rpc(socketPath, 'loop.tick', {
        loopId: 'loop-reap-mine',
        advanced: true,
        actorAgentId: 'loop-reap-a',
      }),
    ).rejects.toThrow(/unknown loopId/);
    await expect(
      rpc(socketPath, 'loop.arm', {
        loopId: 'loop-reap-after',
        intervalMs: 120_000,
        actorAgentId: 'loop-reap-a',
      }),
    ).rejects.toThrow(/live session/);

    const peer = (await rpcAgent(socketPath, 'loop.status', {
      loopId: 'loop-reap-peer',
    })) as { loop: { status: string; agentId: string } | null };
    expect(peer.loop?.status).toBe('armed');
    expect(peer.loop?.agentId).toBe('tok-alice');

    let sawReaped = false;
    for (let i = 0; i < 20; i++) {
      const q = (await rpcAgent(socketPath, 'events.query', {
        eventType: 'loop.reaped',
        limit: 10,
      })) as { events: Array<{ event_type: string; payload: { loopIds?: string[] } | string }> };
      sawReaped = q.events.some((e) => {
        const payload =
          typeof e.payload === 'string'
            ? (JSON.parse(e.payload) as { loopIds?: string[] })
            : e.payload;
        return e.event_type === 'loop.reaped' && payload.loopIds?.includes('loop-reap-mine');
      });
      if (sawReaped) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(sawReaped).toBe(true);
  });
});
