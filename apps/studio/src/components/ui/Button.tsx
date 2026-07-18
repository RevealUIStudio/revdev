import { ButtonCVA as PresentationButton } from '@revealui/presentation';
import type { ButtonHTMLAttributes } from 'react';

const variantMap = {
  primary: 'primary',
  secondary: 'secondary',
  ghost: 'ghost',
  danger: 'destructive',
  success: 'secondary',
} as const;

const sizeMap = {
  sm: 'sm',
  md: 'default',
  lg: 'lg',
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
  return (
    <PresentationButton
      type={type}
      variant={variantMap[variant]}
      size={sizeMap[size]}
      isLoading={loading}
      className={
        variant === 'success'
          ? ['bg-success text-fg font-medium hover:brightness-110', className]
              .filter(Boolean)
              .join(' ')
          : className
      }
      {...props}
    />
  );
}
