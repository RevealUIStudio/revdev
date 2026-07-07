import type { ButtonHTMLAttributes } from 'react';

const variantStyles = {
  primary: 'bg-brand text-on-brand font-medium hover:bg-brand-hover',
  secondary: 'bg-surface-2 text-fg-muted hover:bg-surface-3',
  ghost: 'text-fg-muted hover:text-fg',
  danger: 'bg-error/40 text-error hover:bg-error/60',
  success: 'bg-success text-fg font-medium hover:brightness-110',
} as const;

const sizeStyles = {
  sm: 'px-2.5 py-1 text-xs rounded',
  md: 'px-3 py-1.5 text-sm rounded-md',
  lg: 'px-4 py-2 text-sm rounded-md',
} as const;

export type ButtonVariant = keyof typeof variantStyles;
export type ButtonSize = keyof typeof sizeStyles;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export default function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {loading && (
        <svg
          className="mr-1.5 size-3.5 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"
          />
        </svg>
      )}
      {children}
    </button>
  );
}
