/**
 * `revdev-daemon license-verify` — stdin JWT, JSON stdout, no daemon start.
 */

import {
  fetchLicenseTrustSet,
  isCurrentLicenseTrustSet,
  verifyRegisteredLicense,
} from './license-authority.js';
import { verifyLicenseJWT } from './license-crypto.js';

export async function runLicenseVerifyCommand(
  stdin: string,
): Promise<{ stdout: string; exitCode: number }> {
  const token = stdin.trim();
  const trustSet = await fetchLicenseTrustSet();
  if (!trustSet) {
    return {
      stdout: `${JSON.stringify({ valid: false, reason: 'hosted trust unavailable', authorization: 'unavailable' })}\n`,
      exitCode: 1,
    };
  }
  const result = verifyLicenseJWT(token, trustSet.keys);
  if (!result.valid) {
    return {
      stdout: `${JSON.stringify({ ...result, authorization: 'not-checked' })}\n`,
      exitCode: 1,
    };
  }
  const registered = Boolean(
    result.customerId &&
      result.jti &&
      result.verifiedKeyId &&
      (await verifyRegisteredLicense(
        token,
        {
          tier: result.tier,
          customerId: result.customerId,
          verifiedKeyId: result.verifiedKeyId,
        },
        trustSet,
      )),
  );
  const finalResult = verifyLicenseJWT(token, trustSet.keys);
  const authorized = Boolean(
    registered &&
      isCurrentLicenseTrustSet(trustSet) &&
      finalResult.valid &&
      finalResult.tier === result.tier &&
      finalResult.customerId === result.customerId &&
      finalResult.jti === result.jti &&
      finalResult.verifiedKeyId === result.verifiedKeyId,
  );
  return {
    stdout: `${JSON.stringify({ ...finalResult, authorization: authorized ? 'registered' : 'unavailable' })}\n`,
    exitCode: authorized ? 0 : 1,
  };
}
