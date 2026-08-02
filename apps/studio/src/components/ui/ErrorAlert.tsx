import { Callout } from '@revealui/presentation';

interface ErrorAlertProps {
  message: string | null | undefined;
  className?: string;
}

/**
 * Phase 2 residual (studio-dogfood): shimmed to `@revealui/presentation`
 * `Callout` (variant=error). Presentation's `Alert` is a modal alertdialog
 * and is the wrong primitive for inline panel errors.
 *
 * Consumer API (default export, `message`, `className`) unchanged.
 * Empty / null / undefined message still renders nothing.
 */
export default function ErrorAlert({ message, className = '' }: ErrorAlertProps) {
  if (!message) return null;

  return (
    <Callout variant="error" role="alert" className={className} icon={null}>
      <span className="text-error">{message}</span>
    </Callout>
  );
}
