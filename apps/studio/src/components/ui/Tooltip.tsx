import { Tooltip as PresentationTooltip } from '@revealui/presentation';
import type { ReactNode } from 'react';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: string;
  position?: TooltipPosition;
  children: ReactNode;
}

export default function Tooltip({ content, position = 'top', children }: TooltipProps) {
  return (
    <PresentationTooltip content={content} side={position}>
      {children}
    </PresentationTooltip>
  );
}
