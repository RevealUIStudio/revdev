/**
 * GAP-342 — session.snapshot.write/get/prune RPC (id-match, never mtime).
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

function rpcWithAgent(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return rpc(socketPath, method, { ...params, actorAgentId: 'fid-alice' });
}

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
    sock.setTimeout(8000, () => {
      sock.destroy();
      reject(new Error(`RPC timeout: ${method}`));
    });
  });
}

let dataDir: string;
let socketPath: string;
let close: () => Promise<void>;
let db: PGlite;
let sessionId: string;

beforeAll(async () => {
  const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-fid-'));
  socketPath = join(dataDir, 'harness.sock');
  const d = await startDaemon({ socketPath, dataDir });
  close = d.close;
  db = d._db;
  const reg = (await rpc(socketPath, 'session.register', {
    agentId: 'fid-alice',
    agentName: 'fid-alice',
    task: 'GAP-342 fidelity',
  })) as { sessionId?: string; agentId?: string };
  sessionId = String(reg.sessionId ?? reg.agentId ?? 'fid-alice');
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  const { clearTestLicenseEnv } = await import('./test-license-helper.js');
  clearTestLicenseEnv();
});

describe('session.snapshot schema', () => {
  it('validates write/get/prune shapes', () => {
    expect(
      validateParams('session.snapshot.write', {
        sessionId: 's1',
        sections: { resumeFromHere: 'x' },
      }).valid,
    ).toBe(true);
    expect(validateParams('session.snapshot.get', { sessionId: 's1' }).valid).toBe(true);
    expect(validateParams('session.snapshot.prune', { maxAgeDays: 7 }).valid).toBe(true);
    expect(validateParams('session.snapshot.get', {}).valid).toBe(false);
  });
});

describe('session.snapshot RPC', () => {
  it('writes and gets by session id match only', async () => {
    const written = (await rpcWithAgent(socketPath, 'session.snapshot.write', {
      sessionId,
      sections: {
        resumeFromHere: 'resume at fidelity RPC',
        whatShipped: 'session.snapshot.*',
        openLooseEnds: 'wire Studio UI later',
      },
      mechanical: { branch: 'feat/gap-342', dirty: 0 },
    })) as { written: boolean; sessionId: string };
    expect(written.written).toBe(true);
    expect(written.sessionId).toBe(sessionId);

    const hit = (await rpcWithAgent(socketPath, 'session.snapshot.get', { sessionId })) as {
      snapshot: {
        sessionId: string;
        sections: { resumeFromHere: string };
        mechanical: { branch: string };
      } | null;
    };
    expect(hit.snapshot).not.toBeNull();
    expect(hit.snapshot?.sessionId).toBe(sessionId);
    expect(hit.snapshot?.sections.resumeFromHere).toBe('resume at fidelity RPC');
    expect(hit.snapshot?.mechanical.branch).toBe('feat/gap-342');

    // Different id → null (no mtime fallback)
    const miss = (await rpcWithAgent(socketPath, 'session.snapshot.get', {
      sessionId: 'never-written-session-id',
    })) as { snapshot: null };
    expect(miss.snapshot).toBeNull();
  });

  it('prunes snapshots older than maxAgeDays', async () => {
    // Insert a stale row directly (updated_at in the past)
    await db.query(
      `INSERT INTO session_fidelity_snapshots (session_id, agent_id, sections, mechanical, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, '{}'::jsonb, NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')
       ON CONFLICT (session_id) DO UPDATE SET updated_at = NOW() - INTERVAL '10 days'`,
      [
        'stale-session-id',
        'fid-alice',
        JSON.stringify({
          resumeFromHere: 'old',
          whatShipped: '',
          activeConstraints: '',
          doNotRepeat: '',
          openLooseEnds: '',
        }),
      ],
    );

    const pruned = (await rpcWithAgent(socketPath, 'session.snapshot.prune', {
      maxAgeDays: 7,
    })) as {
      deleted: number;
    };
    expect(pruned.deleted).toBeGreaterThanOrEqual(1);

    const miss = (await rpcWithAgent(socketPath, 'session.snapshot.get', {
      sessionId: 'stale-session-id',
    })) as { snapshot: null };
    expect(miss.snapshot).toBeNull();

    // Fresh snapshot from previous test still present
    const hit = (await rpcWithAgent(socketPath, 'session.snapshot.get', { sessionId })) as {
      snapshot: { sessionId: string } | null;
    };
    expect(hit.snapshot?.sessionId).toBe(sessionId);
  });
});
