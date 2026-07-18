import { ButtonCVA as PresentationButton } from '@revealui/presentation';
import type { ButtonHTMLAttributes } from 'react';

const variantMap = {
  primary: 'primary',
  secondary: 'secondary',
  ghost: 'ghost',
  danger: 'destructive',
  success: 'secondary',
} as const;

/**
 * Presentation's CVA size scale (`sm`=h-10/40px, `default`=h-11/44px,
 * `lg`=h-12/48px) runs noticeably taller than Studio's old hand-rolled
 * buttons (~24-36px, compact desktop chrome). Shifted down a step so
 * Studio keeps its density: `md` (Studio's most-used size) takes
 * presentation's smallest built-in size (`sm`); `lg` takes presentation's
 * `default`. Presentation has nothing smaller than `sm`, so Studio's `sm`
 * stays on presentation `sm` and layers a compact `className` override
 * (h-8) on top — `cn()` appends the caller's `className` last, so it wins
 * over the size variant's own `h-10 px-3 py-2`.
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

export type ButtonVariant = keyof typeof variantMap;
export type ButtonSize = keyof typeof sizeMap;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

/**
 * Phase 2 remainder (2026-07-18): shimmed to render
 * `@revealui/presentation`'s CVA `Button`. Consumer API (default export,
 * `variant`, `size`, `loading`, `className`) unchanged.
 *
 * `success` has no matching presentation variant, so it renders the
 * `secondary` variant's base classes with a `className` color override —
 * the package's `cn()` appends the caller's `className` last, so it wins
 * over the variant's baked-in `bg-*`/`text-*` classes.
 */
export default function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  type = 'button',
  className,
  ...props
}: ButtonProps) {
  const overrideClassName = [
    variant === 'success' && 'bg-success text-fg font-medium hover:brightness-110',
    compactSizeOverride[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <PresentationButton
      type={type}
      variant={variantMap[variant]}
      size={sizeMap[size]}
      isLoading={loading}
      className={overrideClassName || undefined}
      {...props}
    />
  );
}
