import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { base58Encode } from '@revdev/protocol/base58';
import type {
  EnvelopeString,
  SignatureEnvelope,
  SignatureHeader,
  SignaturePayload,
} from '@revdev/protocol/signature';
import { SignatureHeaderSchema, SignaturePayloadSchema } from '@revdev/protocol/signature';

export interface AgentKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyRaw: Uint8Array;
}

export function generateAgentKeypair(): AgentKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const publicKeyPem = publicKey as string;
  const lines = publicKeyPem.split('\n');
  const b64Lines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('-----')) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      b64Lines.push(trimmed);
    }
  }
  const spkiDer = Buffer.from(b64Lines.join(''), 'base64');
  const publicKeyRaw = new Uint8Array(spkiDer.buffer, spkiDer.byteOffset + spkiDer.length - 32, 32);

  return {
    privateKeyPem: privateKey as string,
    publicKeyPem,
    publicKeyRaw: new Uint8Array(publicKeyRaw),
  };
}

export function computeFingerprint(publicKeyRaw: Uint8Array): string {
  return base58Encode(createHash('sha256').update(publicKeyRaw).digest());
}

/**
 * Extract the 32-byte raw Ed25519 public key from an SPKI PEM. Mirrors the
 * extraction in `generateAgentKeypair` (the raw key is the trailing 32 bytes
 * of the SPKI DER). Used when a CLIENT supplies its own public key at
 * `session.register` (the Studio zero-9P model, where the daemon holds only
 * the public half and Studio keeps the private key in its Windows-local
 * vault). Throws on a malformed PEM.
 */
export function spkiPemToRaw(publicKeyPem: string): Uint8Array {
  const b64 = publicKeyPem
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('-----'))
    .map((line) => line.trim())
    .join('');
  const der = Buffer.from(b64, 'base64');
  // Ed25519 SPKI is a fixed 44-byte structure: a 12-byte algorithm-id prefix
  // followed by the 32-byte raw key. Reject anything too short to hold it.
  if (der.length < 32) {
    throw new Error('invalid SPKI public key: too short');
  }
  return new Uint8Array(der.subarray(der.length - 32));
}

export function canonicalizeJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJSON(item));
    return `[${items.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJSON(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

export function hashParams(method: string, params: unknown): string {
  return base58Encode(
    createHash('sha256')
      .update(`${method}:${canonicalizeJSON(params ?? {})}`)
      .digest(),
  );
}

export function base64UrlEncode(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

export function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function signEnvelope(payload: SignaturePayload, privateKeyPem: string): SignatureEnvelope {
  const header: SignatureHeader = { alg: 'EdDSA', typ: 'jws' };
  const rawHeaderB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const rawPayloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const message = `${rawHeaderB64}.${rawPayloadB64}`;
  const signatureBytes = sign(null, Buffer.from(message), privateKeyPem);
  return {
    header,
    payload,
    signature: base64UrlEncode(signatureBytes),
    rawHeaderB64,
    rawPayloadB64,
  };
}

export function serializeEnvelope(envelope: SignatureEnvelope): EnvelopeString {
  return `${envelope.rawHeaderB64}.${envelope.rawPayloadB64}.${envelope.signature}`;
}

export function parseEnvelope(envelopeString: EnvelopeString): SignatureEnvelope | null {
  try {
    const parts = envelopeString.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [headerB64, payloadB64, signature] = parts as [string, string, string];

    let rawHeader: unknown;
    let rawPayload: unknown;
    try {
      rawHeader = JSON.parse(base64UrlDecode(headerB64).toString('utf-8'));
      rawPayload = JSON.parse(base64UrlDecode(payloadB64).toString('utf-8'));
    } catch {
      return null;
    }

    const headerResult = SignatureHeaderSchema.safeParse(rawHeader);
    if (!headerResult.success) {
      return null;
    }
    const payloadResult = SignaturePayloadSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      return null;
    }

    return {
      header: headerResult.data,
      payload: payloadResult.data,
      signature,
      rawHeaderB64: headerB64,
      rawPayloadB64: payloadB64,
    };
  } catch {
    return null;
  }
}

export function verifyEnvelope(envelope: SignatureEnvelope, publicKeyPem: string): boolean {
  try {
    const message = `${envelope.rawHeaderB64}.${envelope.rawPayloadB64}`;
    const signatureBytes = base64UrlDecode(envelope.signature);
    return verify(null, Buffer.from(message), publicKeyPem, signatureBytes);
  } catch {
    return false;
  }
}

export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}
