import { useDegradedMode } from '../../lib/degraded-mode';

/**
 * Persistent banner shown whenever the app is in degraded/mock mode (see
 * `lib/degraded-mode`). Deliberately not dismissible: it must stay visible as
 * long as the surfaces below it are showing fabricated data.
 */
export default function DegradedBanner() {
  const { degraded, reason } = useDegradedMode();
  if (!degraded) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 border-b border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning-text"
    >
      <svg
        className="size-4 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m0 3.75h.008M10.34 3.94l-7.5 12.99A1.5 1.5 0 004.14 19.5h15.72a1.5 1.5 0 001.3-2.57l-7.5-12.99a1.5 1.5 0 00-2.6 0z"
        />
      </svg>
      <span>{reason ?? 'Demo data — not connected to a real system.'}</span>
    </div>
  );
}
