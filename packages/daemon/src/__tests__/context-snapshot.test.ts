/**
 * GAP-459 Phase 1 — context.snapshot composite peer awareness.
 *
 * @vitest-environment node
 */
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../server.js';
import { validateParams } from '../validation/index.js';

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
let db: PGlite;

beforeAll(async () => {
  const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-ctx-'));
  socketPath = join(dataDir, 'harness.sock');
  const d = await startDaemon({ socketPath, dataDir });
  close = d.close;
  db = d._db;
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  const { clearTestLicenseEnv } = await import('./test-license-helper.js');
  clearTestLicenseEnv();
});

describe('context.snapshot schema', () => {
  it('accepts empty params and rejects eventLimit 0', () => {
    expect(validateParams('context.snapshot', {}).valid).toBe(true);
    expect(validateParams('context.snapshot', { eventLimit: 50 }).valid).toBe(true);
    expect(validateParams('context.snapshot', { eventLimit: 0 }).valid).toBe(false);
  });
});

describe('context.snapshot RPC', () => {
  it('shows peer sessions, peer findings, open tasks, and cross-agent reservations', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'ctx-alice',
      agentName: 'ctx-alice',
      task: 'claiming GAP-459',
    });

    await rpc(socketPath, 'session.register', {
      agentId: 'ctx-bob',
      agentName: 'ctx-bob',
      task: 'holding a file',
    });

    // Seed via DB so this test owns the READ surface only (writes stay covered
    // by files.reserve / tasks.create / events.log suites).
    // Use a holder id that never session.register'd on a short-lived socket.
    // register/attach socket-close auto-DELETEs that agent's reservations
    // (server.ts), and our per-RPC test sockets race with that cleanup.
    await db.query(
      `INSERT INTO file_reservations (file_path, agent_id, expires_at, reason)
       VALUES ($1, $2, $3::timestamp, $4)`,
      ['/tmp/gap459-peer-file.ts', 'ctx-holder', '2099-01-01T00:00:00Z', 'gap459'],
    );
    await db.query(`INSERT INTO tasks (id, description, status) VALUES ($1, $2, 'open')`, [
      'task-gap459',
      'GAP-459 open claim — visible in snapshot',
    ]);
    await db.query(
      `INSERT INTO events (agent_id, event_type, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [
        'ctx-bob',
        'peer.finding',
        JSON.stringify({ summary: 'context.snapshot is the read surface' }),
      ],
    );

    const snap = (await rpc(socketPath, 'context.snapshot', {
      actorAgentId: 'ctx-alice',
    })) as {
      available: boolean;
      peers: Array<{ agentId: string; isSelf: boolean; task: string }>;
      reservations: Array<{ path: string; agentId: string }>;
      tasks: Array<{ title: string }>;
      findings: Array<{ eventType: string; agentId: string }>;
      degradation: { mode: string; rule: string };
      rawCounts?: Record<string, number>;
    };

    expect(snap.available).toBe(true);
    expect(snap.degradation).toEqual(
      expect.objectContaining({ mode: 'advisory', rule: 'never-block' }),
    );
    expect(snap.peers.map((p) => p.agentId)).toContain('ctx-bob');
    expect(snap.peers.map((p) => p.agentId)).not.toContain('ctx-alice');
    expect(snap.findings.some((f) => f.eventType === 'peer.finding')).toBe(true);
    expect(snap.tasks.some((t) => String(t.title).includes('GAP-459'))).toBe(true);
    expect(snap.reservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/tmp/gap459-peer-file.ts', agentId: 'ctx-holder' }),
      ]),
    );
  });

  it('includeSelf=true keeps the caller in peers', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'ctx-self',
      agentName: 'ctx-self',
      task: 'self-check',
    });
    const snap = (await rpc(socketPath, 'context.snapshot', {
      actorAgentId: 'ctx-self',
      includeSelf: true,
    })) as { peers: Array<{ agentId: string; isSelf: boolean }> };
    const me = snap.peers.find((p) => p.agentId === 'ctx-self');
    expect(me?.isSelf).toBe(true);
  });
});
