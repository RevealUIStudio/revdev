import { Dialog, DialogActions, DialogBody, DialogTitle } from '@revealui/presentation';
import type { ReactNode } from 'react';

const sizeMap = {
  sm: 'sm' as const,
  md: 'lg' as const,
  lg: '2xl' as const,
};

interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: keyof typeof sizeMap;
}

export default function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  maxWidth = 'md',
}: ModalProps) {
  return (
    <Dialog open={open} onClose={onClose} size={sizeMap[maxWidth]}>
      <DialogTitle>{title}</DialogTitle>
      <DialogBody>{children}</DialogBody>
      {footer && <DialogActions>{footer}</DialogActions>}
    </Dialog>
  );
}
