import { Input as PresentationInput } from '@revealui/presentation';
import type { ComponentProps, InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  mono?: boolean;
}

/**
 * Phase 2 remainder (2026-07-18): shimmed to render `@revealui/presentation`'s
 * headless `Input`, per the studio-dogfood lane plan's audit table. Consumer
 * API (default export, `label`, `hint`, `mono`, `id`, `className`) unchanged.
 *
 * Presentation's headless `Input` exposes `className` on its OUTER wrapping
 * `<span>` only, not the inner `<input>` element, so `mono` is applied via an
 * arbitrary descendant-selector variant (`[&_input]:font-mono`) rather than a
 * plain utility class. `type` is cast at the boundary: this component's public
 * API keeps the full HTML input type surface (unchanged from before the
 * shim), while presentation's `Input` only types the subset every current
 * call site actually passes (email/number/password/text, verified by audit).
 */
export default function Input({
  label,
  hint,
  mono = false,
  id,
  className,
  type,
  ...props
}: InputProps) {
  return (
    <div>
      {label && (
        <label htmlFor={id} className="mb-1 block text-xs font-medium text-fg-muted">
          {label}
          {hint && <span className="ml-1 text-fg-subtle">({hint})</span>}
        </label>
      )}
      <PresentationInput
        id={id}
        type={type as ComponentProps<typeof PresentationInput>['type']}
        className={
          [mono && '[&_input]:font-mono', className].filter(Boolean).join(' ') || undefined
        }
        {...props}
      />
    </div>
  );
}
