import {
  StatusDot as PresentationStatusDot,
  type StatusDotStatus as PresentationStatus,
} from '@revealui/presentation';

const statusMap = {
  ok: 'ok',
  warn: 'warn',
  error: 'error',
  /** Studio legacy name; presentation uses `idle`. */
  off: 'idle',
} as const satisfies Record<string, PresentationStatus>;

const defaultLabel = {
  ok: 'OK',
  warn: 'Warning',
  error: 'Error',
  off: 'Off',
} as const;

export type StatusDotStatus = keyof typeof statusMap;
export type StatusDotSize = 'sm' | 'md';

interface StatusDotProps {
  status: StatusDotStatus;
  /**
   * Accepted for API compatibility. Presentation renders a single size
   * (`size-2.5`); this prop does not change the visual size (same narrowing
   * as the Badge shim).
   */
  size?: StatusDotSize;
  pulse?: boolean;
  className?: string;
  /**
   * Accessible label for assistive tech. Defaults to a per-status word ("OK",
   * "Warning", "Error", "Off"). Pass a richer context string at the call site
   * (e.g. "Database: healthy") when the dot stands alone.
   */
  label?: string;
  /**
   * Set when an adjacent VISIBLE text label already conveys the status (e.g.
   * HealthCard renders "Degraded" next to the dot). The dot is then hidden from
   * screen readers to avoid a redundant double-announcement. Defaults to false.
   */
  decorative?: boolean;
}

/**
 * Phase 2 residual (studio-dogfood): shimmed to `@revealui/presentation`
 * `StatusDot` (requires presentation ≥0.12.0 / Phase-3 quartet publish).
 *
 * Consumer API (default export, `status`, `size`, `pulse`, `label`,
 * `decorative`, `className`) preserved. Studio `off` maps to presentation
 * `idle`. When `decorative` is true, a local token-backed span is used because
 * presentation always exposes `role="img"` + `aria-label`.
 */
export default function StatusDot({
  status,
  pulse = false,
  className = '',
  label,
  decorative = false,
}: StatusDotProps) {
  const fill =
    status === 'ok'
      ? 'bg-[var(--rvui-success)]'
      : status === 'warn'
        ? 'bg-[var(--rvui-warning)]'
        : status === 'error'
          ? 'bg-[var(--rvui-error)]'
          : 'bg-[var(--rvui-text-2)]';

  if (decorative) {
    return (
      <span
        aria-hidden="true"
        className={['relative inline-flex size-2.5 shrink-0 rounded-full', fill, className]
          .filter(Boolean)
          .join(' ')}
      />
    );
  }

  return (
    <PresentationStatusDot
      status={statusMap[status]}
      pulse={pulse}
      label={label ?? defaultLabel[status]}
      className={className || undefined}
    />
  );
}
