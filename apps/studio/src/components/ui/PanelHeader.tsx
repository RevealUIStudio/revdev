import { Heading } from '@revealui/presentation';
import type { ReactNode } from 'react';

interface PanelHeaderProps {
  title: string;
  action?: ReactNode;
}

/**
 * Studio panel header — title + optional right-aligned action slot.
 *
 * Phase 2 PR-1 (2026-05-16): shimmed to render `@revealui/presentation`'s
 * `Heading` for the title element. Consumer API (default export, `title`,
 * `action`) unchanged. Heading defaults to `level={1}` so the rendered
 * element is still `<h1>` — existing tests asserting role=heading level=1
 * continue to pass.
 *
 * See `~/revfleet/.jv/docs/lanes/studio-dogfood/plan.md` and ADR
 * `2026-05-16-fleet-revealui-native-compliance.md`.
 */
export default function PanelHeader({ title, action }: PanelHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <Heading level={1}>{title}</Heading>
      {action}
    </div>
  );
}
