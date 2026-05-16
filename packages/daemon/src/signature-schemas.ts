import { z } from 'zod';

export const SignaturePayloadSchema = z
  .object({
    did: z.string(),
    kid: z.string(),
    nonce: z.string(),
    ts: z.number().int(),
    method: z.string(),
    paramsHash: z.string(),
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
    signature: z.string(),
  })
  .strict();
