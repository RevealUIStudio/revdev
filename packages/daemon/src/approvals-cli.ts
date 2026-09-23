/**
 * Headless `revdev approvals` (GAP-294 design §6.4 / §10 Phase 1).
 *
 * Signs with the same envelope the bridge DaemonClient uses
 * (`REVDEV_AGENT_DID` + `REVDEV_AGENT_PRIVATE_KEY_PEM`) and calls
 * `permission.pending` / `permission.decide`. The decider must be the
 * trusted-client operator; this process only delivers that signed call.
 */

import { connect } from 'node:net';
import { parseDid } from '@revdev/protocol/did';
import {
  generateNonce,
  hashParams,
  serializeEnvelope,
  signEnvelope,
} from './agent-identity-crypto.js';
import { DAEMON_DEFAULTS } from './config.js';

export type ApprovalsCommand =
  | { cmd: 'list' }
  | { cmd: 'decide'; approvalId: string; verdict: 'approved' | 'denied' }
  | { cmd: 'help' }
  | { cmd: 'error'; message: string };

export function parseApprovalsArgs(args: string[]): ApprovalsCommand {
  const [head, ...rest] = args;
  if (!head || head === 'list' || head === '--help' || head === '-h') {
    if (head === '--help' || head === '-h') return { cmd: 'help' };
    if (!head || head === 'list') return { cmd: 'list' };
  }
  if (head === 'decide') {
    const approvalId = rest[0]?.trim() ?? '';
    const verdict = (rest[1] ?? '').trim().toLowerCase();
    if (!approvalId || (verdict !== 'approved' && verdict !== 'denied')) {
      return {
        cmd: 'error',
        message: 'usage: revdev approvals decide <approvalId> <approved|denied>',
      };
    }
    return { cmd: 'decide', approvalId, verdict };
  }
  return {
    cmd: 'error',
    message: 'usage: revdev approvals [list | decide <approvalId> <approved|denied>]',
  };
}

interface SigningConfig {
  did: string;
  fingerprint: string;
  privateKeyPem: string;
}

function signingFromEnv(env: NodeJS.ProcessEnv): SigningConfig | { error: string } {
  const did = env.REVDEV_AGENT_DID?.trim();
  const privateKeyPem = env.REVDEV_AGENT_PRIVATE_KEY_PEM;
  if (!did || !privateKeyPem) {
    return {
      error:
        'revdev approvals requires REVDEV_AGENT_DID and REVDEV_AGENT_PRIVATE_KEY_PEM for the trusted operator',
    };
  }
  const parsed = parseDid(did);
  if (!parsed) return { error: 'REVDEV_AGENT_DID is not a valid did:revealfleet identity' };
  return { did, fingerprint: parsed.fingerprint, privateKeyPem };
}

function daemonCall(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  signing: SigningConfig,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = 1;
    const payload = {
      did: signing.did,
      kid: signing.fingerprint,
      nonce: generateNonce(),
      ts: Math.floor(Date.now() / 1000),
      method,
      paramsHash: hashParams(method, params),
    };
    const req = {
      jsonrpc: '2.0' as const,
      id,
      method,
      params,
      'x-revdev-signature': serializeEnvelope(signEnvelope(payload, signing.privateKeyPem)),
    };
    const socket = connect(socketPath);
    let buffer = '';
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });
    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: { code: number; message: string };
          };
          if (resp.id === id) {
            socket.end();
            if (resp.error) {
              reject(new Error(`Daemon error ${resp.error.code}: ${resp.error.message}`));
            } else {
              resolve(resp.result);
            }
          }
        } catch {
          buffer = `${line}\n${buffer}`;
        }
      }
    });
    socket.on('error', (err) => {
      reject(new Error(`Daemon connection failed: ${err.message}. Is revdev-daemon running?`));
    });
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('Daemon request timed out'));
    });
  });
}

export async function runApprovalsCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const parsed = parseApprovalsArgs(args);
  if (parsed.cmd === 'help') {
    out('usage: revdev approvals [list | decide <approvalId> <approved|denied>]');
    return 0;
  }
  if (parsed.cmd === 'error') {
    err(parsed.message);
    return 2;
  }
  const signing = signingFromEnv(env);
  if ('error' in signing) {
    err(signing.error);
    return 2;
  }
  const socketPath = env.REVDEV_DAEMON_SOCKET ?? DAEMON_DEFAULTS.socketPath;
  try {
    if (parsed.cmd === 'list') {
      const result = await daemonCall(socketPath, 'permission.pending', {}, signing);
      out(JSON.stringify(result, null, 2));
      return 0;
    }
    const result = await daemonCall(
      socketPath,
      'permission.decide',
      { approvalId: parsed.approvalId, verdict: parsed.verdict },
      signing,
    );
    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (callErr) {
    err(callErr instanceof Error ? callErr.message : String(callErr));
    return 1;
  }
}
