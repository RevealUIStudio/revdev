interface TierBadgeProps {
  tier: string;
}

export default function TierBadge({ tier }: TierBadgeProps) {
  const color =
    tier === 'T1'
      ? 'bg-accent/20 text-accent border-accent/30'
      : tier === 'T0'
        ? 'bg-surface-3/30 text-fg-muted border-edge-strong/30'
        : 'bg-surface-2 text-fg-subtle border-edge';

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${color}`}
    >
      {tier}
    </span>
  );
}
