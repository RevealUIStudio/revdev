import { IconAlertTriangle } from '@revealui/presentation';
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
      <IconAlertTriangle size="sm" className="shrink-0" />
      <span>{reason ?? 'Demo data — not connected to a real system.'}</span>
    </div>
  );
}
