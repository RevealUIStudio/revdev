/**
 * LoginScreen — first-run gate
 *
 * Local Studio is the primary path. Account sign-in is optional and only
 * needed for API-backed features. The previous layout led with email OTP
 * and buried local mode under a ghost button, so a first click felt like
 * a no-op.
 */

import { useEffect, useRef, useState } from 'react';
import { useAuthContext } from '../../hooks/use-auth';
import { useSettingsContext } from '../../hooks/use-settings';
import Button from '../adapters/Button';
import ErrorAlert from '../adapters/ErrorAlert';
import Input from '../adapters/Input';

const RESEND_COOLDOWN_SECONDS = 30;

type GateView = 'choose' | 'signin';

export default function LoginScreen() {
  const { step, loading, error, sendOtp, submitOtp } = useAuthContext();
  const { settings, updateSettings } = useSettingsContext();
  const [view, setView] = useState<GateView>('choose');
  const [startingLocal, setStartingLocal] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  function startCooldown(): void {
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    intervalRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          const timer = intervalRef.current;
          if (timer !== null) {
            clearInterval(timer);
            intervalRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function startLocalMode(): void {
    setFormError(null);
    setStartingLocal(true);
    updateSettings({ localMode: true });
  }

  async function handleSendOtp(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!email.trim()) {
      setFormError('Enter the email that should receive the code.');
      return;
    }
    setFormError(null);
    const ok = await sendOtp(settings.apiUrl, email.trim());
    if (ok) {
      setOtpSent(true);
      startCooldown();
    }
  }

  async function handleVerify(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!code.trim() || code.length !== 6) {
      setFormError('Enter the 6-digit code from the email.');
      return;
    }
    setFormError(null);
    await submitOtp(settings.apiUrl, email.trim(), code.trim());
  }

  async function handleResend(): Promise<void> {
    setCode('');
    setFormError(null);
    await sendOtp(settings.apiUrl, email.trim());
    startCooldown();
  }

  const showOtp = step === 'otp' || otpSent;
  const showSignIn = view === 'signin' || showOtp;
  const resendBlocked = resendCooldown > 0;
  const gateError = formError ?? error;

  if (!showSignIn) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-surface-0">
        <div className="w-full max-w-md space-y-6 rounded-xl border border-edge bg-surface-1 p-8">
          <div className="text-center">
            <h1 className="text-lg font-semibold text-fg">RevDev</h1>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">
              Studio is the desktop app for the RevDev daemon on this machine. You can start locally
              without an account.
            </p>
          </div>

          <ErrorAlert message={gateError} />

          <div className="space-y-3">
            <Button
              type="button"
              variant="primary"
              size="lg"
              loading={startingLocal}
              disabled={startingLocal}
              onClick={startLocalMode}
              className="h-auto w-full flex-col items-start gap-1 rounded-lg px-4 py-3 text-left"
            >
              <span className="text-sm font-semibold">Work on this machine</span>
              <span className="text-xs font-normal opacity-90">
                Opens terminal, git, vault, and Agent Approvals. No RevealUI account needed.
              </span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              disabled={startingLocal}
              onClick={() => {
                setFormError(null);
                setView('signin');
              }}
              className="h-auto w-full flex-col items-start gap-1 rounded-lg border border-edge px-4 py-3 text-left"
            >
              <span className="text-sm font-semibold text-fg">Sign in with email</span>
              <span className="text-xs font-normal text-fg-muted">
                Connect Studio to a RevealUI API for account features. You will get a one-time code.
              </span>
            </Button>
          </div>

          <p className="text-center text-[11px] leading-relaxed text-fg-subtle">
            After local start, Studio asks whether you want to develop in repos or deploy a
            business. You can skip the setup checklist and open Agent → Approvals from there.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-surface-0">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-edge bg-surface-1 p-8">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-fg">RevDev</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {showOtp ? 'Enter the 6-digit code from your email' : 'Sign in to a RevealUI account'}
          </p>
        </div>

        <ErrorAlert message={gateError} />

        {showOtp ? null : (
          <form onSubmit={handleSendOtp} className="space-y-4">
            <Input
              id="email"
              label="Email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
            <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
              Send verification code
            </Button>
          </form>
        )}

        {showOtp ? (
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-xs text-fg-subtle">
              We sent a 6-digit code to <span className="text-fg-muted">{email}</span>
            </p>
            <Input
              id="otp-code"
              label="Verification code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              mono
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
              required
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              disabled={code.length !== 6}
              className="w-full"
            >
              Verify
            </Button>
            <div className="flex items-center justify-between text-xs">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  handleResend().catch(() => undefined);
                }}
                disabled={loading || resendBlocked}
                className="h-auto p-0 text-fg-subtle hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {resendBlocked ? `Resend in ${resendCooldown}s` : 'Resend code'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOtpSent(false);
                  setCode('');
                  setFormError(null);
                }}
                className="h-auto p-0 text-fg-subtle hover:text-fg-muted"
              >
                Use a different email
              </Button>
            </div>
          </form>
        ) : null}

        <div className="space-y-2 border-t border-edge pt-4">
          <Button
            type="button"
            variant="ghost"
            loading={startingLocal}
            disabled={startingLocal}
            onClick={startLocalMode}
            className="w-full rounded-md border border-edge px-3 py-2 text-sm text-fg-muted transition-colors hover:border-brand hover:text-fg"
          >
            Work on this machine instead
          </Button>
          <p className="text-center text-[11px] text-fg-subtle">
            Sign-in contacts {settings.apiUrl}. Local mode does not.
          </p>
        </div>
      </div>
    </div>
  );
}
