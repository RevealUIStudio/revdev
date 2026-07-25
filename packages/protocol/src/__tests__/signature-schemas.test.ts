import { describe, expect, it } from 'vitest';
import {
  SignatureEnvelopeSchema,
  SignatureHeaderSchema,
  SignaturePayloadSchema,
} from '../signature-schemas.js';

const validPayload = {
  did: 'did:revfleet:agt-001:abc123',
  kid: 'abc123',
  nonce: '0'.repeat(32),
  ts: 1234567890,
  method: 'session.register',
  paramsHash: 'deadbeef',
};

const validHeader = { alg: 'EdDSA', typ: 'jws' } as const;

const validEnvelope = {
  header: validHeader,
  payload: validPayload,
  signature: 'a'.repeat(86),
  rawHeaderB64: 'a'.repeat(20),
  rawPayloadB64: 'a'.repeat(100),
};

describe('SignaturePayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(SignaturePayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('requires nonce to be exactly 32 characters', () => {
    expect(
      SignaturePayloadSchema.safeParse({ ...validPayload, nonce: '0'.repeat(31) }).success,
    ).toBe(false);
    expect(
      SignaturePayloadSchema.safeParse({ ...validPayload, nonce: '0'.repeat(33) }).success,
    ).toBe(false);
  });

  it('requires ts to be a non-negative integer', () => {
    expect(SignaturePayloadSchema.safeParse({ ...validPayload, ts: -1 }).success).toBe(false);
    expect(SignaturePayloadSchema.safeParse({ ...validPayload, ts: 1.5 }).success).toBe(false);
  });

  it('rejects an empty method, did, kid, or paramsHash', () => {
    expect(SignaturePayloadSchema.safeParse({ ...validPayload, method: '' }).success).toBe(false);
    expect(SignaturePayloadSchema.safeParse({ ...validPayload, did: '' }).success).toBe(false);
    expect(SignaturePayloadSchema.safeParse({ ...validPayload, kid: '' }).success).toBe(false);
    expect(SignaturePayloadSchema.safeParse({ ...validPayload, paramsHash: '' }).success).toBe(
      false,
    );
  });

  it('rejects fields past their DoS-guard bounds', () => {
    expect(
      SignaturePayloadSchema.safeParse({ ...validPayload, did: 'd'.repeat(513) }).success,
    ).toBe(false);
    expect(
      SignaturePayloadSchema.safeParse({ ...validPayload, method: 'm'.repeat(129) }).success,
    ).toBe(false);
  });

  it('rejects unknown properties (strict mode)', () => {
    expect(SignaturePayloadSchema.safeParse({ ...validPayload, extra: 'nope' }).success).toBe(
      false,
    );
  });
});

describe('SignatureHeaderSchema', () => {
  it('accepts the fixed EdDSA/jws header', () => {
    expect(SignatureHeaderSchema.safeParse(validHeader).success).toBe(true);
  });

  it('rejects any other algorithm or type literal', () => {
    expect(SignatureHeaderSchema.safeParse({ alg: 'RS256', typ: 'jws' }).success).toBe(false);
    expect(SignatureHeaderSchema.safeParse({ alg: 'EdDSA', typ: 'jwt' }).success).toBe(false);
  });

  it('rejects unknown properties (strict mode)', () => {
    expect(SignatureHeaderSchema.safeParse({ ...validHeader, extra: 'nope' }).success).toBe(false);
  });
});

describe('SignatureEnvelopeSchema', () => {
  it('accepts a well-formed envelope', () => {
    expect(SignatureEnvelopeSchema.safeParse(validEnvelope).success).toBe(true);
  });

  it('rejects a nested payload or header that fails its own schema', () => {
    expect(
      SignatureEnvelopeSchema.safeParse({
        ...validEnvelope,
        payload: { ...validPayload, ts: -1 },
      }).success,
    ).toBe(false);
    expect(
      SignatureEnvelopeSchema.safeParse({
        ...validEnvelope,
        header: { alg: 'RS256', typ: 'jws' },
      }).success,
    ).toBe(false);
  });

  it('rejects fields past their DoS-guard bounds', () => {
    expect(
      SignatureEnvelopeSchema.safeParse({ ...validEnvelope, signature: 'a'.repeat(129) }).success,
    ).toBe(false);
    expect(
      SignatureEnvelopeSchema.safeParse({ ...validEnvelope, rawHeaderB64: 'a'.repeat(257) })
        .success,
    ).toBe(false);
    expect(
      SignatureEnvelopeSchema.safeParse({ ...validEnvelope, rawPayloadB64: 'a'.repeat(8193) })
        .success,
    ).toBe(false);
  });

  it('rejects unknown properties (strict mode)', () => {
    expect(SignatureEnvelopeSchema.safeParse({ ...validEnvelope, extra: 'nope' }).success).toBe(
      false,
    );
  });
});
