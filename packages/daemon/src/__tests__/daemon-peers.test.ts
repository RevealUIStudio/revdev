/**
 * GAP-154 Phase 5 — daemon peer registry (Neon role=daemon) + daemon.peers RPC.
 * @vitest-environment node
 */
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetForTesting,
  getSelfDaemonId,
  listDaemonPeers,
  registerDaemonPeer,
  setNeonClientForTesting,
} from '../neon.js';
import { startDaemon } from '../server.js';

function createPeerNeonStore(): {
  mock: (
    strings: TemplateStringsArray | readonly string[],
    ...values: unknown[]
  ) => Promise<unknown>;
  agents: Map<
    string,
    { id: string; env: string; last_seen: string; metadata: Record<string, unknown> }
  >;
} {
  const agents = new Map<
    string,
    { id: string; env: string; last_seen: string; metadata: Record<string, unknown> }
  >();

  const mock = (strings: TemplateStringsArray | readonly string[], ...values: unknown[]) => {
    const sql = Array.from(strings).join(' ').replace(/\s+/g, ' ').trim().toUpperCase();

    if (sql.includes('INSERT INTO COORDINATION_AGENTS')) {
      // VALUES (id, env, NOW(), 0, metadata) — NOW() is SQL literal
      const id = String(values[0] ?? '');
      const env = String(values[1] ?? '');
      let metadata: Record<string, unknown> = {};
      try {
        // values[2] is total_sessions (0); values[3] is metadata JSON
        metadata = JSON.parse(String(values[3] ?? values[2] ?? '{}')) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
      const existing = agents.get(id);
      agents.set(id, {
        id,
        env,
        last_seen: new Date().toISOString(),
        metadata: existing ? { ...existing.metadata, ...metadata } : metadata,
      });
      return Promise.resolve([]);
    }

    if (sql.includes('UPDATE COORDINATION_AGENTS') && sql.includes('LAST_SEEN')) {
      const id = String(values[0] ?? '');
      const existing = agents.get(id);
      if (existing) {
        agents.set(id, { ...existing, last_seen: new Date().toISOString() });
      }
      return Promise.resolve([]);
    }

    if (sql.includes('FROM COORDINATION_AGENTS') && sql.includes('ROLE')) {
      const rows = [...agents.values()]
        .filter((a) => a.metadata.role === 'daemon')
        .map((a) => ({
          id: a.id,
          env: a.env,
          last_seen: a.last_seen,
          metadata: a.metadata,
        }));
      return Promise.resolve(rows);
    }

    // Session dual-writes unused here
    return Promise.resolve([]);
  };

  return { mock: mock as any, agents };
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
      sock.end();
      try {
        const resp = JSON.parse(buf.slice(0, nl));
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

describe('GAP-154 Phase 5 daemon peer registry', () => {
  const store = createPeerNeonStore();
  let dataDir: string;
  let socketPath: string;
  let close: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'daemon-peers-'));
    socketPath = join(dataDir, 'harness.sock');
  });

  afterAll(async () => {
    if (close) await close();
    _resetForTesting();
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store.agents.clear();
    setNeonClientForTesting(store.mock);
  });

  it('registerDaemonPeer upserts role=daemon agent', async () => {
    await registerDaemonPeer({
      daemonId: 'daemon:test-host:abc',
      env: 'test-host',
      hostname: 'test-host',
      httpGatewayUrl: 'http://127.0.0.1:9999',
      socketHint: '/tmp/sock',
      pid: 1234,
    });
    expect(getSelfDaemonId()).toBe('daemon:test-host:abc');
    const peers = await listDaemonPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.id).toBe('daemon:test-host:abc');
    expect(peers[0]?.httpGatewayUrl).toBe('http://127.0.0.1:9999');
    expect(peers[0]?.role).toBe('daemon');
  });

  it('daemon.peers RPC returns self + neonSyncActive', async () => {
    if (close) {
      await close();
      close = null;
    }
    // startDaemon → initNeonSync() clears any prior test client when
    // POSTGRES_URL is unset. Inject mock after listen (same as fleet suite).
    const handle = await startDaemon({
      socketPath,
      dataDir,
      httpPort: 0,
      pruneIntervalMs: 0,
      trustedAnchorRequireRootOwned: false,
    });
    close = () => handle.close();
    setNeonClientForTesting(store.mock);
    await registerDaemonPeer({
      daemonId: 'daemon:rpc-host:xyz',
      env: 'rpc-host',
      hostname: 'rpc-host',
      httpGatewayUrl: null,
      socketHint: socketPath,
      pid: process.pid,
    });

    const result = (await rpc(socketPath, 'daemon.peers', {})) as {
      neonSyncActive: boolean;
      selfId: string | null;
      peers: Array<{ id: string; isSelf: boolean }>;
    };
    expect(result.neonSyncActive).toBe(true);
    expect(result.selfId).toBe('daemon:rpc-host:xyz');
    expect(result.peers.some((p) => p.isSelf)).toBe(true);
  });
});
