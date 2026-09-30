import { type ChildProcess, fork } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateTestLicense } from './test-license-helper.js';

type Reply = { error?: { code: number }; result?: unknown };
const children: ChildProcess[] = [];
const hosts: Array<{ dir: string; socket: string; base: string; bearer: string; actor: string }> =
  [];
const kit = generateTestLicense('enterprise');
let revoked = false;
let unavailable = false;
let checks = 0;
let root: string;
const authority = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const presented = JSON.parse(body);
  checks += 1;
  response.setHeader('Content-Type', 'application/json');
  if (unavailable) {
    response.writeHead(503);
    response.end('{}');
    return;
  }
  response.end(
    JSON.stringify({
      valid: !revoked && presented.licenseKey === kit.licenseKey,
      reason: revoked ? 'revoked' : 'valid',
      tier: 'enterprise',
      customerId: 'synthetic-customer',
      licenseKeyDigest: createHash('sha256').update(kit.licenseKey).digest('hex'),
    }),
  );
});

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Missing fixture port'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function socketRpc(
  socket: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const connection = connect(socket);
    let data = '';
    connection.on('connect', () =>
      connection.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`),
    );
    connection.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      connection.destroy();
      try {
        resolve(JSON.parse(data.split('\n')[0] ?? ''));
      } catch (error) {
        reject(error);
      }
    });
    connection.once('error', reject);
    connection.setTimeout(10_000, () => {
      connection.destroy();
      reject(new Error('Fixture RPC timeout'));
    });
  });
}

async function httpRpc(host: (typeof hosts)[number], method: string): Promise<Reply> {
  const response = await fetch(`${host.base}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { actorAgentId: host.actor } }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Reply;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'revdev-two-hosts-'));
  await new Promise<void>((resolve, reject) => {
    authority.once('error', reject);
    authority.listen(0, '127.0.0.1', resolve);
  });
  const address = authority.address();
  if (!address || typeof address === 'string') throw new Error('Missing authority fixture port');
  for (let index = 0; index < 2; index += 1) {
    const dir = await mkdtemp(join(root, `host-${index}-`));
    const socket = join(dir, 'daemon.sock');
    const port = await freePort();
    const child = fork(
      fileURLToPath(new URL('./fixtures/shared-revocation-daemon.ts', import.meta.url)),
      [],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          NODE_ENV: 'test',
          REVEALUI_LICENSE_KEY: kit.licenseKey,
          REVDEV_LICENSE_PUBLIC_KEY: kit.publicKey,
          REVDEV_DAEMON_DATA: dir,
          REVEALUI_REVOKED_JTI_FILE: join(dir, 'revoked.json'),
        },
      },
    );
    children.push(child);
    let diagnostics = '';
    child.stdout?.on('data', (chunk) => {
      diagnostics += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      diagnostics += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Fixture startup timeout: ${diagnostics}`)),
        45_000,
      );
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`Fixture exited: ${diagnostics}`));
      });
      child.once('message', (message: { ready?: boolean; error?: string }) => {
        clearTimeout(timer);
        if (message.ready) resolve();
        else reject(new Error(message.error));
      });
      child.send({
        dataDir: dir,
        socketPath: socket,
        httpPort: port,
        authority: `http://127.0.0.1:${address.port}/verify`,
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const nonce = (await (await fetch(`${base}/api/pair`)).json()) as { nonce: string };
    const secret = (await readFile(join(dir, 'gateway-pairing-secret'), 'utf8')).trim();
    const paired = (await (
      await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: nonce.nonce,
          hmac: createHmac('sha256', secret).update(nonce.nonce).digest('hex'),
        }),
      })
    ).json()) as { token: string };
    const registered = await socketRpc(socket, 'session.register', {
      agentName: `synthetic-host-${index}`,
      workDir: dir,
      backend: 'studio',
    });
    expect(registered.error).toBeUndefined();
    const actor = (registered.result as { sessionId: string }).sessionId;
    expect(actor).toBeTypeOf('string');
    hosts.push({ dir, socket, base, bearer: paired.token, actor });
  }
  expect(children[0]?.pid).toBeTypeOf('number');
  expect(children[1]?.pid).toBeTypeOf('number');
  expect(children[0]?.pid).not.toBe(children[1]?.pid);
}, 100_000);

afterAll(async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          if (child.connected) child.send({ shutdown: true });
          else child.kill('SIGTERM');
        }),
    ),
  );
  await new Promise<void>((resolve) => authority.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
}, 30_000);

it('denies both independent live hosts through socket and HTTP immediately after authority revoke or outage', async () => {
  for (const host of hosts) {
    expect(
      (await socketRpc(host.socket, 'events.query', { actorAgentId: host.actor })).error,
    ).toBeUndefined();
    expect((await httpRpc(host, 'events.query')).error).toBeUndefined();
  }
  const before = checks;
  expect(before).toBe(4);
  unavailable = true;
  for (const host of hosts) {
    expect(
      (await socketRpc(host.socket, 'events.query', { actorAgentId: host.actor })).error?.code,
    ).toBe(-32001);
    expect((await httpRpc(host, 'events.query')).error?.code).toBe(-32001);
    expect((await socketRpc(host.socket, 'ping')).error).toBeUndefined();
    expect((await httpRpc(host, 'ping')).error).toBeUndefined();
  }
  expect(checks - before).toBe(4);
  unavailable = false;
  revoked = true;
  for (const host of hosts) {
    expect(
      (await socketRpc(host.socket, 'events.query', { actorAgentId: host.actor })).error?.code,
    ).toBe(-32001);
    expect((await httpRpc(host, 'events.query')).error?.code).toBe(-32001);
    expect((await socketRpc(host.socket, 'ping')).error).toBeUndefined();
    expect((await httpRpc(host, 'ping')).error).toBeUndefined();
  }
}, 30_000);
