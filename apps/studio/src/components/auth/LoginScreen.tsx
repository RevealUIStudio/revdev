/**
 * LoginScreen — Device Authentication Flow
 *
 * Two-step flow:
 * 1. Enter email → OTP sent to inbox
 * 2. Enter 6-digit OTP code → bearer token issued
 *
 * Matches the Studio visual style (dark theme, orange accent).
 */

import { useEffect, useRef, useState } from 'react';
import { useAuthContext } from '../../hooks/use-auth';
import { useSettingsContext } from '../../hooks/use-settings';
import Button from '../ui/Button';
import Input from '../ui/Input';

const RESEND_COOLDOWN_SECONDS = 30;

export default function LoginScreen() {
  const { step, loading, error, sendOtp, submitOtp } = useAuthContext();
  const { settings, updateSettings } = useSettingsContext();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
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
          clearInterval(intervalRef.current!);
          intervalRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  async function handleSendOtp(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!email.trim()) return;
    const ok = await sendOtp(settings.apiUrl, email.trim());
    if (ok) {
      setOtpSent(true);
      startCooldown();
    }
  }

  async function handleVerify(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!code.trim() || code.length !== 6) return;
    await submitOtp(settings.apiUrl, email.trim(), code.trim());
  }

  async function handleResend(): Promise<void> {
    setCode('');
    await sendOtp(settings.apiUrl, email.trim());
    startCooldown();
  }

  const showOtp = step === 'otp' || otpSent;
  const resendBlocked = resendCooldown > 0;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-neutral-950">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-neutral-800 bg-neutral-900 p-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-lg font-semibold text-neutral-100">RevealUI Studio</h1>
          <p className="mt-1 text-sm text-neutral-400">
            {showOtp ? 'Enter verification code' : 'Sign in to your account'}
          </p>
        </div>

        {/* Error */}
        {error ? (
          <div className="rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        ) : null}

        {/* Email Step */}
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

        {/* OTP Step */}
        {showOtp ? (
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-xs text-neutral-500">
              We sent a 6-digit code to <span className="text-neutral-300">{email}</span>
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
              <button
                type="button"
                onClick={handleResend}
                disabled={loading || resendBlocked}
                className="text-neutral-500 hover:text-orange-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {resendBlocked ? `Resend in ${resendCooldown}s` : 'Resend code'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOtpSent(false);
                  setCode('');
                }}
                className="text-neutral-500 hover:text-neutral-300"
              >
                Use different email
              </button>
            </div>
          </form>
        ) : null}

        {/* Local mode escape hatch (email step only) */}
        {showOtp ? null : (
          <div className="space-y-2 border-t border-neutral-800 pt-4">
            <button
              type="button"
              onClick={() => updateSettings({ localMode: true })}
              className="w-full rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100"
            >
              Continue in local mode
            </button>
            <p className="text-center text-[11px] text-neutral-600">
              Use local tools (terminal, shell, git) without signing in. Account features stay
              disabled until you sign in.
            </p>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-[11px] text-neutral-600">Connecting to {settings.apiUrl}</p>
      </div>
    </div>
  );
}
