/**
 * DaemonClient request signing tests.
 *
 * DaemonClient accepts an optional signingConfig in its constructor
 * (second parameter) so tests can inject a known keypair without touching
 * env vars. The module-level env-based path is exercised via resolveSigningConfig().
 *
 * Socket I/O is intercepted by mocking node:net's connect() to return a
 * fake EventEmitter that captures written frames.
 *
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { computeFingerprint, generateAgentKeypair } from '@revdev/daemon/crypto';
import { formatDid } from '@revdev/protocol/did';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient, resolveSigningConfig } from '../client.js';

vi.mock('node:net', () => ({
  connect: vi.fn(),
}));

interface FakeSocket extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
}

function makeFakeSocket(replyResult: unknown = { pong: true }): FakeSocket {
  const sock = new EventEmitter() as FakeSocket;
  sock.end = vi.fn();
  sock.destroy = vi.fn();
  sock.setTimeout = vi.fn();
  sock.write = vi.fn((data: string) => {
    const parsed = JSON.parse(data.trim()) as { id: number };
    const reply = `${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: replyResult })}\n`;
    setImmediate(() => sock.emit('data', Buffer.from(reply)));
    return true;
  });
  return sock;
}

function buildValidConfig(): {
  did: string;
  fingerprint: string;
  privateKeyPem: string;
  publicKeyPem: string;
} {
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid('bridge-test-agent', fingerprint);
  return { did, fingerprint, privateKeyPem: kp.privateKeyPem, publicKeyPem: kp.publicKeyPem };
}

let fakeSocket: FakeSocket;
let connectMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fakeSocket = makeFakeSocket();
  const net = await import('node:net');
  connectMock = net.connect as ReturnType<typeof vi.fn>;
  connectMock.mockReturnValue(fakeSocket);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function _captureFrame(
  client: DaemonClient,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let frame: Record<string, unknown> = {};
  fakeSocket.write = vi.fn((data: string) => {
    const parsed = JSON.parse(data.trim()) as { id: number } & Record<string, unknown>;
    frame = parsed;
    const reply = `${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } })}\n`;
    setImmediate(() => {
      fakeSocket.emit('connect');
      fakeSocket.emit('data', Buffer.from(reply));
    });
    return true;
  });

  const callPromise = client.call(method, params);
  fakeSocket.emit('connect');
  await callPromise;
  return frame;
}

describe('DaemonClient signing', () => {
  it('sends x-revdev-signature when signingConfig is provided', async () => {
    const cfg = buildValidConfig();
    const client = new DaemonClient('/tmp/test.sock', {
      did: cfg.did,
      fingerprint: cfg.fingerprint,
      privateKeyPem: cfg.privateKeyPem,
    });

    let writtenFrame: Record<string, unknown> = {};
    fakeSocket.write = vi.fn((data: string) => {
      writtenFrame = JSON.parse(data.trim()) as Record<string, unknown>;
      const id = (writtenFrame as { id: number }).id;
      const reply = `${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } })}\n`;
      setImmediate(() => fakeSocket.emit('data', Buffer.from(reply)));
      return true;
    });

    const callPromise = client.call('ping', {});
    fakeSocket.emit('connect');
    await callPromise;

    expect(typeof writtenFrame['x-revdev-signature']).toBe('string');
    const sig = writtenFrame['x-revdev-signature'] as string;
    expect(sig.split('.').length).toBe(3);
  });

  it('does not send x-revdev-signature when signingConfig is null', async () => {
    const client = new DaemonClient('/tmp/test.sock', null);

    let writtenFrame: Record<string, unknown> = {};
    fakeSocket.write = vi.fn((data: string) => {
      writtenFrame = JSON.parse(data.trim()) as Record<string, unknown>;
      const id = (writtenFrame as { id: number }).id;
      const reply = `${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } })}\n`;
      setImmediate(() => fakeSocket.emit('data', Buffer.from(reply)));
      return true;
    });

    const callPromise = client.call('ping', {});
    fakeSocket.emit('connect');
    await callPromise;

    expect(writtenFrame['x-revdev-signature']).toBeUndefined();
  });

  it('does not send signature when only REVDEV_AGENT_DID is set (no private key)', () => {
    const { did } = buildValidConfig();
    vi.stubEnv('REVDEV_AGENT_DID', did);
    const config = resolveSigningConfig();
    expect(config).toBeNull();
  });

  it('does not send signature when REVDEV_AGENT_DID is invalid format', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('REVDEV_AGENT_DID', 'not-a-valid-did');
    vi.stubEnv('REVDEV_AGENT_PRIVATE_KEY_PEM', 'some-key');

    const config = resolveSigningConfig();

    expect(config).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid REVDEV_AGENT_DID'));
    warnSpy.mockRestore();
  });

  it('both env vars absent: resolveSigningConfig returns null', () => {
    const config = resolveSigningConfig();
    expect(config).toBeNull();
  });
});
