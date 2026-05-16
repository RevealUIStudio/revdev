export interface SignaturePayload {
  did: string;
  kid: string;
  nonce: string;
  ts: number;
  method: string;
  paramsHash: string;
}

export interface SignatureHeader {
  alg: 'EdDSA';
  typ: 'jws';
}

export interface SignatureEnvelope {
  header: SignatureHeader;
  payload: SignaturePayload;
  signature: string;
  // The literal base64url segments that were signed. Verification re-uses
  // these instead of re-serializing header/payload, so signatures produced
  // by clients with non-canonical JSON key order still verify correctly.
  rawHeaderB64: string;
  rawPayloadB64: string;
}

export type EnvelopeString = string;
