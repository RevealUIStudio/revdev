import { Button as PresentationButton } from '@revealui/presentation';
import type { ButtonHTMLAttributes } from 'react';

/**
 * Studio consumer variants → presentation (0.12+) axes:
 * `variant` is colour intent; `appearance` is visual weight.
 */
const intentMap = {
  primary: { variant: 'brand', appearance: 'solid' },
  secondary: { variant: 'neutral', appearance: 'solid' },
  ghost: { variant: 'neutral', appearance: 'ghost' },
  danger: { variant: 'danger', appearance: 'solid' },
  success: { variant: 'success', appearance: 'solid' },
} as const;

/**
 * Presentation size scale (0.12+): sm=h-10, default=h-11, lg=h-12.
 * Studio density: md (most-used) takes presentation `sm`; lg takes
 * presentation `default`. Studio `sm` stays on presentation `sm` with a
 * compact className override (h-8) so dense chrome survives.
 */
const sizeMap = {
  sm: 'sm',
  md: 'sm',
  lg: 'default',
} as const;

const compactSizeOverride = {
  sm: 'h-8 px-2 py-1 text-xs',
  md: undefined,
  lg: undefined,
} as const;

export type ButtonVariant = keyof typeof intentMap;
export type ButtonSize = keyof typeof sizeMap;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

/**
 * Phase 2 residual (studio-dogfood): re-shimmed for `@revealui/presentation`
 * 0.12+ Button API (variant × appearance axes, post Catalyst re-authorship).
 * Consumer API (default export, `variant`, `size`, `loading`, `className`)
 * unchanged.
 */
export default function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  type = 'button',
  className,
  ...props
}: ButtonProps) {
  const intent = intentMap[variant];
  // Ghost chrome stays body ink on a raised surface. Presentation 0.13
  // ghost+neutral still hovers to accent-foreground (ink-on-amber), which
  // vanishes on Studio's dark card. Drop this override when Studio depends
  // on a presentation release that ships hover:text-foreground for ghost.
  const ghostContrast =
    variant === 'ghost' ? 'text-fg hover:bg-surface-2! hover:text-fg!' : undefined;
  const overrideClassName = [compactSizeOverride[size], ghostContrast, className]
    .filter(Boolean)
    .join(' ');

  return (
    <PresentationButton
      type={type}
      variant={intent.variant}
      appearance={intent.appearance}
      size={sizeMap[size]}
      isLoading={loading}
      className={overrideClassName || undefined}
      {...props}
    />
  );
}
