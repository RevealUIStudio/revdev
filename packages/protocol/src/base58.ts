// Hand-rolled base58btc (zero-deps constraint per ADR 2026-05-16-revdev-did-ed25519). RFC-compliant; alphabet matches Bitcoin.

export const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz' as const;

const ALPHABET_SET = new Set<string>(BASE58_ALPHABET.split(''));

const CHAR_TO_VALUE = new Map<string, bigint>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  CHAR_TO_VALUE.set(BASE58_ALPHABET[i] as string, BigInt(i));
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  let leadingZeros = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      leadingZeros++;
    } else {
      break;
    }
  }

  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = value * 256n + BigInt(bytes[i] as number);
  }

  let result = '';
  while (value > 0n) {
    const remainder = value % 58n;
    value = value / 58n;
    result = (BASE58_ALPHABET[Number(remainder)] as string) + result;
  }

  return '1'.repeat(leadingZeros) + result;
}

export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) {
    return new Uint8Array(0);
  }

  for (let i = 0; i < s.length; i++) {
    if (!ALPHABET_SET.has(s[i] as string)) {
      throw new Error(`base58: invalid character '${s[i]}' at position ${i}`);
    }
  }

  let leadingZeros = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '1') {
      leadingZeros++;
    } else {
      break;
    }
  }

  let value = 0n;
  for (let i = 0; i < s.length; i++) {
    value = value * 58n + (CHAR_TO_VALUE.get(s[i] as string) as bigint);
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value = value / 256n;
  }

  const result = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    result[leadingZeros + i] = bytes[i] as number;
  }
  return result;
}
