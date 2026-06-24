import { z } from 'zod';

// Field bounds are DoS guards: every string is attacker-supplied and parsed
// before the signature is verified, so an unbounded field lets a single frame
// pin memory/CPU. The caps are generous relative to the real shapes (Ed25519 +
// did:revdev + sha256) so a legitimate envelope always fits. `nonce` is the
// tightest: `generateNonce()` is exactly `randomBytes(16).toString('hex')` →
// 32 hex chars, so it is length-pinned rather than capped.
export const SignaturePayloadSchema = z
  .object({
    did: z.string().min(1).max(512),
    kid: z.string().min(1).max(128),
    nonce: z.string().length(32),
    ts: z.number().int().nonnegative(),
    method: z.string().min(1).max(128),
    paramsHash: z.string().min(1).max(64),
  })
  .strict();

export const SignatureHeaderSchema = z
  .object({
    alg: z.literal('EdDSA'),
    typ: z.literal('jws'),
  })
  .strict();

export const SignatureEnvelopeSchema = z
  .object({
    header: SignatureHeaderSchema,
    payload: SignaturePayloadSchema,
    // Ed25519 signature is 64 bytes → 86 base64url chars; the raw segments are
    // the base64url of the (bounded) header + payload JSON. Cap all three.
    signature: z.string().min(1).max(128),
    rawHeaderB64: z.string().min(1).max(256),
    rawPayloadB64: z.string().min(1).max(8192),
  })
  .strict();
