/**
 * Studio status indicator — a small decorative colored dot.
 *
 * Phase 2 PR-1 (2026-05-16): status colors migrated from hardcoded
 * Tailwind palette classes (`bg-green-500`, `bg-yellow-500`, `bg-red-500`,
 * `bg-neutral-600`) to `--rvui-success/warning/error/text-2` design tokens
 * defined in `@revealui/presentation/tokens.css`. Consumer API
 * (default export, `status`, `size`, `pulse`, `className`) unchanged.
 *
 * StatusDot itself has no `@revealui/presentation` equivalent yet
 * (presentation has `Badge` for text content, but no pure decorative dot
 * primitive). It is named as a future promotion candidate. For Phase 2
 * PR-1, the dot is token-backed but still lives in Studio.
 *
 * Sequencing tracked in the internal Studio dogfood lane plan;
 * design rule codified in the internal fleet RevealUI-native
 * compliance ADR.
 */

const statusMeta = {
  ok: { color: 'bg-[var(--rvui-success)]', label: 'OK' },
  warn: { color: 'bg-[var(--rvui-warning)]', label: 'Warning' },
  error: { color: 'bg-[var(--rvui-error)]', label: 'Error' },
  off: { color: 'bg-[var(--rvui-text-2)]', label: 'Off' },
} as const;

const sizeMap = {
  sm: 'size-2',
  md: 'size-2.5',
} as const;

interface StatusDotProps {
  status: keyof typeof statusMeta;
  size?: keyof typeof sizeMap;
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
   * screen readers to avoid a redundant double-announcement. Defaults to false,
   * so a bare dot announces its status via `role="img"` + `aria-label`.
   */
  decorative?: boolean;
}

export default function StatusDot({
  status,
  size = 'sm',
  pulse = false,
  className = '',
  label,
  decorative = false,
}: StatusDotProps) {
  const meta = statusMeta[status];
  // Color alone is not an accessible status cue (color-only fails WCAG 1.4.1 and
  // is ambiguous for colorblind users). A bare dot therefore exposes its status
  // as text to assistive tech; a dot paired with a visible label opts out.
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': label ?? meta.label } as const);

  return (
    <span
      className={`inline-block shrink-0 rounded-full ${meta.color} ${sizeMap[size]} ${pulse ? 'animate-pulse' : ''} ${className}`}
      {...a11y}
    />
  );
}
