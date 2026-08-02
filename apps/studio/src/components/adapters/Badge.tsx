import { Badge as PresentationBadge } from '@revealui/presentation';
import type { ReactNode } from 'react';

const colorMap = {
  default: 'muted',
  success: 'success',
  warning: 'warning',
  error: 'danger',
  info: 'sky',
  brand: 'brand',
} as const;

export type BadgeVariant = keyof typeof colorMap;
export type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children: ReactNode;
  className?: string;
}

/**
 * Phase 2 remainder (2026-07-18): shimmed to render
 * `@revealui/presentation`'s `Badge`. Consumer API (default export,
 * `variant`, `size`, `className`) unchanged.
 *
 * `size` is accepted but has no visible effect: presentation's `Badge`
 * renders at one fixed size and always overwrites any `style` prop passed to
 * it with its own internal `style` object (its JSX spreads `...props` before
 * setting `style`, so a caller-supplied `style` is clobbered, not merged) —
 * there is no override path. Kept in the type only so the one call site that
 * passes `size="sm"` (SshBookmarkSidebar) keeps compiling; the visual size
 * difference is an accepted narrowing of this shim, consistent with the
 * lane's "visible behavior shifts as a side effect" premise.
 */
export default function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <PresentationBadge color={colorMap[variant]} className={className}>
      {children}
    </PresentationBadge>
  );
}
