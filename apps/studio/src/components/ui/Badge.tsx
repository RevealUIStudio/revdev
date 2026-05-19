import type { ReactNode } from 'react';

const variantClasses = {
  default: 'bg-white/5 text-zinc-400',
  success: 'bg-green-500/10 text-green-400',
  warning: 'bg-yellow-400/10 text-yellow-300',
  error: 'bg-red-500/10 text-red-400',
  info: 'bg-blue-500/15 text-blue-400',
  brand: 'bg-emerald-500/10 text-emerald-400',
} as const;

const sizeClasses = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
} as const;

export type BadgeVariant = keyof typeof variantClasses;
export type BadgeSize = keyof typeof sizeClasses;

interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children: ReactNode;
  className?: string;
}

export default function Badge({
  variant = 'default',
  size = 'md',
  children,
  className = '',
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      style={{
        borderRadius: 'var(--rvui-radius-full, 9999px)',
        transition:
          'background-color var(--rvui-duration-fast, 120ms) var(--rvui-ease, cubic-bezier(0.22, 1, 0.36, 1))',
      }}
    >
      {children}
    </span>
  );
}
