/**
 * Launch-path license auto-provision. Runs once when auth becomes ready with
 * licenseAutoProvision enabled. Does not install a 6h timer (PR-4).
 */

import { useEffect, useRef, useState } from 'react';
import {
  type LicenseProvisionOutcome,
  licenseProvisionMessage,
  runLicenseProvision,
} from '../lib/license-provision';
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

  useEffect(() => {
    if (
      step !== 'authenticated' ||
      settings.localMode ||
      !settings.licenseAutoProvision ||
      signingOut
    ) {
      return;
    }
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
    step,
    signingOut,
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
