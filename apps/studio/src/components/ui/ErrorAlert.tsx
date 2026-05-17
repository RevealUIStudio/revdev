interface ErrorAlertProps {
  message: string | null | undefined;
  className?: string;
}

export default function ErrorAlert({ message, className = '' }: ErrorAlertProps) {
  if (!message) return null;

  return (
    <div
      className={`rounded-md border border-[var(--rvui-error)]/30 bg-[var(--rvui-error-subtle)] px-4 py-3 text-sm text-[var(--rvui-error)] ${className}`}
      role="alert"
    >
      {message}
    </div>
  );
}
