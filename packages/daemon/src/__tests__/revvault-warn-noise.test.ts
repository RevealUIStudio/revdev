/**
 * Identity vault-mirror warn dedup — the daemon-noise heartbeat fix.
 *
 * Session-keyed identities (GAP-311) mint a fresh keypair on every session
 * registration, and each registration mirrors it to revvault. On a machine
 * where the revvault CLI is not on the daemon's PATH (the systemd-user unit),
 * every registration used to emit the same
 * "revvault private/public key write failed, reason: cli-not-installed" warn
 * pair — one pair per heartbeat/session cycle, forever.
 *
 * `cli-not-installed` is environmental, not per-agent: warn once per daemon
 * lifetime, then skip further vault-write attempts until restart. Real
 * `cli-failure` results keep their per-agent warns.
 *
 * @vitest-environment node
 */
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Capture warns without a real logger. Only createLogger is stubbed; every
// other logger export keeps its real implementation.
const { warnCalls } = vi.hoisted(() => ({
  warnCalls: [] as Array<{ msg: string; meta: unknown }>,
}));
vi.mock('@revealui/utils/logger', async (importActual) => {
  const actual = await importActual<typeof import('@revealui/utils/logger')>();
  const stub = (): Record<string, unknown> => ({
    debug() {},
    info() {},
    error() {},
    fatal() {},
    warn(msg: string, meta?: unknown) {
      warnCalls.push({ msg, meta });
    },
    child() {
      return stub();
    },
  });
  return { ...actual, createLogger: () => stub() };
});

// Force the environmental failure deterministically (and keep the suite from
// ever spawning a real `revvault set` on a developer machine).
const { revvaultSetMock } = vi.hoisted(() => ({
  revvaultSetMock: vi.fn(async () => ({
    ok: false as const,
    reason: 'cli-not-installed' as const,
  })),
}));
vi.mock('../revvault-client.js', async (importActual) => {
  const actual = await importActual<typeof import('../revvault-client.js')>();
  return { ...actual, revvaultSet: revvaultSetMock };
});

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../server.js';

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
let originalLicenseKey: string | undefined;

beforeAll(async () => {
  const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
  originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-vaultwarn-'));
  socketPath = join(dataDir, 'harness.sock');
  const d = await startDaemon({ socketPath, dataDir });
  close = d.close;
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  if (originalLicenseKey === undefined) {
    delete process.env.REVEALUI_LICENSE_KEY;
  } else {
    process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
  }
  const { clearTestLicenseEnv } = await import('./test-license-helper.js');
  clearTestLicenseEnv();
});

describe('revvault cli-not-installed warn dedup', () => {
  it('warns once across repeated session registrations, then skips vault writes', async () => {
    await rpc(socketPath, 'session.register', {
      agentName: 'noisy-one',
      workDir: '/tmp/noisy-one',
      backend: 'test',
    });
    await rpc(socketPath, 'session.register', {
      agentName: 'noisy-two',
      workDir: '/tmp/noisy-two',
      backend: 'test',
    });
    await rpc(socketPath, 'session.register', {
      agentName: 'noisy-three',
      workDir: '/tmp/noisy-three',
      backend: 'test',
    });

    const vaultWarns = warnCalls.filter((c) => c.msg.includes('revvault'));
    expect(vaultWarns).toHaveLength(1);
    expect(vaultWarns[0]?.msg).toContain('suppressing further warnings');

    // First registration attempts the private-key write, hits the missing
    // CLI, and no further spawn is attempted for it or any later session.
    expect(revvaultSetMock).toHaveBeenCalledTimes(1);
  });
});
