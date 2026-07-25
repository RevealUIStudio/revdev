import { connect } from 'node:net';
import { generateNonce, hashParams, serializeEnvelope, signEnvelope } from '@revdev/daemon/crypto';
import { parseDid } from '@revdev/protocol/did';

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  'x-revdev-signature'?: string;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface SigningConfig {
  did: string;
  fingerprint: string;
  privateKeyPem: string;
}

export function resolveSigningConfig(): SigningConfig | null {
  const did = process.env.REVDEV_AGENT_DID;
  const privateKeyPem = process.env.REVDEV_AGENT_PRIVATE_KEY_PEM;
  if (!did || !privateKeyPem) return null;
  const parsed = parseDid(did);
  if (!parsed) {
    console.warn('[revdev-bridge] invalid REVDEV_AGENT_DID, bridge will run unsigned');
    return null;
  }
  return { did, fingerprint: parsed.fingerprint, privateKeyPem };
}

export class DaemonClient {
  private socketPath: string;
  private nextId = 1;
  private signingConfig: SigningConfig | null;

  constructor(socketPath?: string, signingConfig?: SigningConfig | null) {
    const home = process.env.HOME ?? '/tmp';
    this.socketPath = socketPath ?? `${home}/.local/share/revealui/harness.sock`;
    this.signingConfig = signingConfig !== undefined ? signingConfig : resolveSigningConfig();
  }

  /** True when this client will attach an Ed25519 envelope on every call. */
  get isSigned(): boolean {
    return this.signingConfig !== null;
  }

  /**
   * Signature-required methods need a signed client. Call before worktree /
   * file mutations so operators get an actionable error instead of -32003.
   */
  requireSigned(method: string): void {
    if (this.signingConfig !== null) return;
    throw new Error(
      `${method} requires a signed bridge client. Set REVDEV_AGENT_DID and ` +
        `REVDEV_AGENT_PRIVATE_KEY_PEM (agent identity from session.register / revvault ` +
        `revdev/agents/<id>/identity/*), then restart the bridge.`,
    );
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const req: RpcRequest = { jsonrpc: '2.0', id, method, params };

      if (this.signingConfig) {
        const payload = {
          did: this.signingConfig.did,
          kid: this.signingConfig.fingerprint,
          nonce: generateNonce(),
          ts: Math.floor(Date.now() / 1000),
          method,
          paramsHash: hashParams(method, params),
        };
        const envelope = signEnvelope(payload, this.signingConfig.privateKeyPem);
        req['x-revdev-signature'] = serializeEnvelope(envelope);
      }

      const socket = connect(this.socketPath);
      let buffer = '';

      socket.on('connect', () => {
        socket.write(`${JSON.stringify(req)}\n`);
      });

      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const resp: RpcResponse = JSON.parse(line);
            if (resp.id === id) {
              socket.end();
              if (resp.error) {
                reject(new Error(`Daemon error ${resp.error.code}: ${resp.error.message}`));
              } else {
                resolve(resp.result);
              }
            }
          } catch {
            // incomplete JSON, wait for more data
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

  async ping(): Promise<boolean> {
    try {
      await this.call('ping');
      return true;
    } catch {
      return false;
    }
  }
}
