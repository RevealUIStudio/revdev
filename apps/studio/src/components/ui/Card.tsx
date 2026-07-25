import { Card as PresentationCard } from '@revealui/presentation';
import type { ReactNode } from 'react';

const variantClassMap = {
  default: '',
  elevated: 'border-edge-strong shadow-lg hover:shadow-lg',
  ghost: 'bg-transparent border-edge-subtle shadow-none hover:shadow-none',
} as const;

const paddingClassMap = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
} as const;

export type CardVariant = keyof typeof variantClassMap;
export type CardPadding = keyof typeof paddingClassMap;

interface CardProps {
  variant?: CardVariant;
  padding?: CardPadding;
  header?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Phase 2 remainder (2026-07-18): shimmed to render
 * `@revealui/presentation`'s `Card`. Consumer API (default export, `variant`,
 * `padding`, `header`, `className`) unchanged. Presentation's `Card` has no
 * variant/padding/header axis of its own, so those studio-specific concerns
 * are layered on as `className` overrides (`cn()` appends the caller's
 * `className` last, so it wins over the base `border-*`/`shadow-*` classes)
 * plus the same header+divider markup that predates the shim.
 */
export default function Card({
  variant = 'default',
  padding = 'md',
  header,
  children,
  className,
}: CardProps) {
  return (
    <PresentationCard
      className={[variantClassMap[variant], paddingClassMap[padding], className]
        .filter(Boolean)
        .join(' ')}
    >
      {header && <div className="mb-3 border-b border-edge pb-3">{header}</div>}
      {children}
    </PresentationCard>
  );
}
