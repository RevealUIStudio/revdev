/**
 * License auto-provision: launch fetch plus 6h idle / 15min focus-online poll.
 * Does not add license.reload (rotation still uses daemon_restart).
 */

import { useEffect, useRef, useState } from 'react';
import {
  type LicenseProvisionOutcome,
  licenseProvisionMessage,
  runLicenseProvision,
} from '../lib/license-provision';
import { attachLicensePoll, recordsSuccessfulCurrent } from '../lib/license-provision-poll';
import { useAuthContext } from './use-auth';
import { useSettingsContext } from './use-settings';

export interface LicenseProvisionState {
  outcome: LicenseProvisionOutcome | null;
  message: string | null;
  running: boolean;
}

export function useLicenseProvision(): LicenseProvisionState {
  const { step, getToken, getSigningOut, getStep, signingOut } = useAuthContext();
  const { settings } = useSettingsContext();
  const [outcome, setOutcome] = useState<LicenseProvisionOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const pollRef = useRef<ReturnType<typeof attachLicensePoll> | null>(null);

  const gated =
    step === 'authenticated' && !settings.localMode && settings.licenseAutoProvision && !signingOut;

  useEffect(() => {
    if (!gated) {
      pollRef.current?.dispose();
      pollRef.current = null;
      return;
    }

    const run = async () => {
      setRunning(true);
      try {
        const result = await runLicenseProvision({
          apiUrl: settings.apiUrl,
          getToken,
          getSigningOut,
          getStep,
          localMode: settings.localMode,
          licenseAutoProvision: settings.licenseAutoProvision,
        });
        setOutcome(result);
        return result;
      } finally {
        setRunning(false);
      }
    };

    const poll = attachLicensePoll(run);
    pollRef.current = poll;

    return () => {
      poll.dispose();
      if (pollRef.current === poll) pollRef.current = null;
    };
  }, [
    gated,
    settings.apiUrl,
    settings.localMode,
    settings.licenseAutoProvision,
    getToken,
    getSigningOut,
    getStep,
  ]);

  useEffect(() => {
    if (!gated) return;
    if (inFlight.current) return;

    const controller = new AbortController();
    inFlight.current = true;
    setRunning(true);

    runLicenseProvision({
      apiUrl: settings.apiUrl,
      getToken,
      getSigningOut,
      getStep,
      localMode: settings.localMode,
      licenseAutoProvision: settings.licenseAutoProvision,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setOutcome(result);
          if (recordsSuccessfulCurrent(result)) {
            pollRef.current?.noteSuccess();
          }
        }
      })
      .finally(() => {
        inFlight.current = false;
        if (!controller.signal.aborted) {
          setRunning(false);
        }
      });

    return () => {
      controller.abort();
      inFlight.current = false;
    };
  }, [
    gated,
    settings.apiUrl,
    settings.localMode,
    settings.licenseAutoProvision,
    getToken,
    getSigningOut,
    getStep,
  ]);

  return {
    outcome,
    message: outcome ? licenseProvisionMessage(outcome) : null,
    running,
  };
}
