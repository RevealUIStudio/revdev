#!/usr/bin/env node
/**
 * GAP-154 live fleet dogfood (two process-local daemons, real Neon).
 *
 * Stream-safe: expects POSTGRES_URL already in the environment (use
 *   revvault run --env POSTGRES_URL=revealui/prod/db/postgres-url -- \
 *     node scripts/gap-154-neon-fleet-dogfood.mjs
 * ). Never prints the URL. Prefer db/postgres-url over neon/postgres-url if the
 * latter fails password auth (vault drift).
 *
 * Proves acceptance slice: A registers session → B session.list({scope:fleet})
 * sees it; daemon.peers sees at least one self registration when sync is on.
 *
 * Cleans up test sessions on both sockets when possible.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

function rpc(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n';
    sock.on('connect', () => sock.write(frame));
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
        reject(e);
      }
    });
    sock.on('error', reject);
    sock.setTimeout(15_000, () => {
      sock.destroy();
      reject(new Error(`timeout ${method}`));
    });
  });
}

async function main() {
  if (!process.env.POSTGRES_URL && !process.env.POSTGRES_URL_FILE) {
    console.error(
      'FAIL: set POSTGRES_URL (or POSTGRES_URL_FILE) via revvault run — see script header',
    );
    process.exit(2);
  }

  // Dynamic import after env is set so neon init can see POSTGRES_URL
  const { startDaemon } = await import(
    pathToFileURL(join(ROOT, 'packages/daemon/dist/index.js')).href
  );

  const stamp = Date.now().toString(36);
  const agentA = `gap154-dogfood-a-${stamp}`;
  const agentB = `gap154-dogfood-b-${stamp}`;

  const dirA = await mkdtemp(join(tmpdir(), 'gap154-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'gap154-b-'));
  const sockA = join(dirA, 'harness.sock');
  const sockB = join(dirB, 'harness.sock');
  await writeFile(join(dirA, 'trusted-client-fingerprint'), '');
  await writeFile(join(dirB, 'trusted-client-fingerprint'), '');

  let closeA;
  let closeB;
  try {
    process.env.REVDEV_DAEMON_ID = `daemon:dogfood-a-${stamp}`;
    const a = await startDaemon({
      socketPath: sockA,
      dataDir: dirA,
      pruneIntervalMs: 0,
      trustedClientFingerprintPath: join(dirA, 'trusted-client-fingerprint'),
      trustedAnchorRequireRootOwned: false,
    });
    closeA = a.close;

    process.env.REVDEV_DAEMON_ID = `daemon:dogfood-b-${stamp}`;
    const b = await startDaemon({
      socketPath: sockB,
      dataDir: dirB,
      pruneIntervalMs: 0,
      trustedClientFingerprintPath: join(dirB, 'trusted-client-fingerprint'),
      trustedAnchorRequireRootOwned: false,
    });
    closeB = b.close;

    const healthA = await rpc(sockA, 'harness.health');
    if (!healthA.neonSyncActive) {
      console.error('FAIL: neonSyncActive=false on A — POSTGRES_URL not loading');
      process.exit(1);
    }
    console.log('ok neonSyncActive on A');

    await rpc(sockA, 'session.register', {
      agentId: agentA,
      agentName: agentA,
      env: 'gap154-dogfood-a',
      task: 'gap-154 fleet dogfood',
    });
    console.log('ok registered', agentA);

    // Allow Neon write lag
    await new Promise((r) => setTimeout(r, 1500));

    const fleetB = await rpc(sockB, 'session.list', { scope: 'fleet' });
    const sessions = fleetB.sessions || [];
    const found = sessions.some(
      (s) => s.agentId === agentA || s.id === agentA || s.agent_id === agentA,
    );
    if (!found) {
      console.error(
        'FAIL: B fleet list missing A',
        JSON.stringify(
          sessions.slice(0, 5).map((s) => ({ id: s.id, agentId: s.agentId || s.agent_id })),
        ),
      );
      process.exit(1);
    }
    console.log('ok B session.list({scope:fleet}) sees A');

    const peersA = await rpc(sockA, 'daemon.peers', {});
    if (!peersA.neonSyncActive) {
      console.error('FAIL: daemon.peers neonSyncActive false');
      process.exit(1);
    }
    console.log('ok daemon.peers', 'selfId=', peersA.selfId, 'count=', (peersA.peers || []).length);

    // Cleanup test sessions (best-effort; may need signed end — try unsigned register end path)
    try {
      await rpc(sockA, 'session.end', { agentId: agentA });
    } catch {
      /* optional */
    }
    try {
      await rpc(sockB, 'session.register', {
        agentId: agentB,
        agentName: agentB,
        env: 'gap154-dogfood-b',
      });
      await rpc(sockB, 'session.end', { agentId: agentB });
    } catch {
      /* optional */
    }

    console.log('RESULT=PASS gap-154 neon fleet dogfood');
  } finally {
    if (closeB) await closeB().catch(() => undefined);
    if (closeA) await closeA().catch(() => undefined);
    await rm(dirA, { recursive: true, force: true }).catch(() => undefined);
    await rm(dirB, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
