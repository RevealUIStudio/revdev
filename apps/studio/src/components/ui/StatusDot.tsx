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
 * primitive). It is named as a promotion candidate in Phase 5 of the
 * studio-dogfood lane plan. For Phase 2 PR-1, the dot is token-backed but
 * still lives in Studio.
 *
 * See `~/revfleet/.jv/docs/lanes/studio-dogfood/plan.md` and ADR
 * `2026-05-16-fleet-revealui-native-compliance.md`.
 */

const colorMap = {
  ok: 'bg-[var(--rvui-success)]',
  warn: 'bg-[var(--rvui-warning)]',
  error: 'bg-[var(--rvui-error)]',
  off: 'bg-[var(--rvui-text-2)]',
} as const;

const sizeMap = {
  sm: 'size-2',
  md: 'size-2.5',
} as const;

interface StatusDotProps {
  status: keyof typeof colorMap;
  size?: keyof typeof sizeMap;
  pulse?: boolean;
  className?: string;
}

export default function StatusDot({
  status,
  size = 'sm',
  pulse = false,
  className = '',
}: StatusDotProps) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${colorMap[status]} ${sizeMap[size]} ${pulse ? 'animate-pulse' : ''} ${className}`}
      aria-hidden="true"
    />
  );
}
