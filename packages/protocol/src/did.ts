import { BASE58_ALPHABET } from './base58.js';

export const DID_PREFIX = 'did:revfleet:' as const;

const FINGERPRINT_ALPHABET_SET = new Set<string>(BASE58_ALPHABET.split(''));

export function isValidAgentIdChar(c: string): boolean {
  return (
    c.length === 1 &&
    ((c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      c === '_' ||
      c === '-')
  );
}

export function isValidAgentId(s: string): boolean {
  if (s.length === 0 || s.length > 128) {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    if (!isValidAgentIdChar(s[i] as string)) {
      return false;
    }
  }
  return true;
}

export function isValidFingerprint(s: string): boolean {
  if (s.length === 0 || s.length > 128) {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    if (!FINGERPRINT_ALPHABET_SET.has(s[i] as string)) {
      return false;
    }
  }
  return true;
}

export function formatDid(agentId: string, fingerprint: string): string {
  if (!isValidAgentId(agentId)) {
    throw new TypeError(`invalid agentId: ${agentId}`);
  }
  if (!isValidFingerprint(fingerprint)) {
    throw new TypeError(`invalid fingerprint: ${fingerprint}`);
  }
  return `${DID_PREFIX}${agentId}:${fingerprint}`;
}

export function parseDid(did: string): { agentId: string; fingerprint: string } | null {
  if (!did.startsWith(DID_PREFIX)) {
    return null;
  }
  const rest = did.slice(DID_PREFIX.length);
  const colonIndex = rest.indexOf(':');
  if (colonIndex === -1) {
    return null;
  }
  const agentId = rest.slice(0, colonIndex);
  const fingerprint = rest.slice(colonIndex + 1);
  if (agentId.length === 0 || fingerprint.length === 0) {
    return null;
  }
  if (fingerprint.indexOf(':') !== -1) {
    return null;
  }
  return { agentId, fingerprint };
}
