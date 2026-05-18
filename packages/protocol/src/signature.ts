import type { z } from 'zod';
import {
  SignatureEnvelopeSchema,
  SignatureHeaderSchema,
  SignaturePayloadSchema,
} from './signature-schemas.js';

export type SignaturePayload = z.infer<typeof SignaturePayloadSchema>;
export type SignatureHeader = z.infer<typeof SignatureHeaderSchema>;
export type SignatureEnvelope = z.infer<typeof SignatureEnvelopeSchema>;

export type EnvelopeString = string;

export { SignatureEnvelopeSchema, SignatureHeaderSchema, SignaturePayloadSchema };
