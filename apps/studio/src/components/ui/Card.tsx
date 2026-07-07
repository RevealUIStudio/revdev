import type { ReactNode } from 'react';

const variantStyles = {
  default: 'bg-surface-1 border border-edge rounded-lg',
  elevated: 'bg-surface-1 border border-edge-strong rounded-lg shadow-lg',
  ghost: 'bg-transparent border border-edge-subtle rounded-lg',
} as const;

const paddingStyles = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
} as const;

export type CardVariant = keyof typeof variantStyles;
export type CardPadding = keyof typeof paddingStyles;

interface CardProps {
  variant?: CardVariant;
  padding?: CardPadding;
  header?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function Card({
  variant = 'default',
  padding = 'md',
  header,
  children,
  className = '',
}: CardProps) {
  return (
    <div className={`${variantStyles[variant]} ${paddingStyles[padding]} ${className}`}>
      {header && <div className="mb-3 border-b border-edge pb-3">{header}</div>}
      {children}
    </div>
  );
}
