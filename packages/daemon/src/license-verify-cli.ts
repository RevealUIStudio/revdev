/**
 * `revdev-daemon license-verify` — stdin JWT, JSON stdout, no daemon start.
 */

import { getVendorPublicKey, verifyLicenseJWT } from './license-crypto.js';

export function runLicenseVerifyCommand(stdin: string): { stdout: string; exitCode: number } {
  const token = stdin.trim();
  const result = verifyLicenseJWT(token, getVendorPublicKey());
  return {
    stdout: `${JSON.stringify(result)}\n`,
    exitCode: result.valid ? 0 : 1,
  };
}
