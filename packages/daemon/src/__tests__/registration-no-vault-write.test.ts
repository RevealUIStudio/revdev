/**
 * Registration performs ZERO revvault writes — GAP-409 D1 regression guard.
 *
 * The daemon-minted identity path used to mirror every fresh keypair into
 * revvault (`revdev/agents/<id>/identity/*`). Session-keyed identities
 * (GAP-311) made that mirror inverted — ephemeral per-session keys
 * accumulating in a durable vault — and any test or dogfood run on a shell
 * with the revvault CLI on PATH polluted the PRODUCTION secret store (the
 * ~33 stray `revdev/agents/*` entries found at the GAP-409 D6 sweep).
 *
 * The write path is deleted, not made quieter (this file previously guarded
 * the revdev#318 warn-once dedup of that path's missing-CLI noise). This
 * guard asserts the daemon never calls revvaultSet — and never logs a vault
 * warn — across repeated session registrations.
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

// Spy on the vault write entry point. Post GAP-409 D1 it must NEVER be
// called from the daemon; the mock both proves that and keeps any regression
// from spawning a real `revvault set` against the production store.
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

describe('registration performs zero revvault writes (GAP-409 D1)', () => {
  it('never calls revvaultSet and never logs a vault warn across registrations', async () => {
    const one = (await rpc(socketPath, 'session.register', {
      agentName: 'novault-one',
      workDir: '/tmp/novault-one',
      backend: 'test',
    })) as { privateKeyPem?: string };
    await rpc(socketPath, 'session.register', {
      agentName: 'novault-two',
      workDir: '/tmp/novault-two',
      backend: 'test',
    });
    await rpc(socketPath, 'session.register', {
      agentName: 'novault-three',
      workDir: '/tmp/novault-three',
      backend: 'test',
    });

    // The one-shot key still comes back on first mint — removal of the
    // mirror must not touch the client contract (D2).
    expect(one.privateKeyPem).toContain('PRIVATE KEY');

    // The mirror is gone: no vault write attempt, no vault warn, ever.
    expect(revvaultSetMock).not.toHaveBeenCalled();
    const vaultWarns = warnCalls.filter((c) => c.msg.includes('revvault'));
    expect(vaultWarns).toHaveLength(0);
  });
});
