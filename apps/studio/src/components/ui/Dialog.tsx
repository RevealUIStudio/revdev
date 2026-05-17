import {
  Dialog as PresentationDialog,
  DialogActions,
  DialogBody,
  DialogDescription,
  DialogTitle,
} from '@revealui/presentation';
import type { ReactNode } from 'react';

const sizeMap = {
  sm: 'sm' as const,
  md: 'lg' as const,
  lg: '2xl' as const,
};

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  actions?: ReactNode;
  maxWidth?: keyof typeof sizeMap;
}

export default function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  maxWidth = 'md',
}: DialogProps) {
  return (
    <PresentationDialog open={open} onClose={onClose} size={sizeMap[maxWidth]}>
      <DialogTitle>{title}</DialogTitle>
      {description && <DialogDescription>{description}</DialogDescription>}
      {children && <DialogBody>{children}</DialogBody>}
      {actions && <DialogActions>{actions}</DialogActions>}
    </PresentationDialog>
  );
}
