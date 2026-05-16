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
}

export type EnvelopeString = string;
