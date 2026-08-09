import { describe, expect, it } from 'vitest';
import { buildFleetMermaid, mermaidSafeId } from '../../lib/fleet-map-graph';

describe('mermaidSafeId', () => {
  it('keeps alnum and underscore', () => {
    expect(mermaidSafeId('INIT-002')).toBe('INIT_002');
    expect(mermaidSafeId('GAP-360')).toBe('GAP_360');
  });
});

describe('buildFleetMermaid', () => {
  it('renders empty graph message', () => {
    const r = buildFleetMermaid([], []);
    expect(r.nodeCount).toBe(0);
    expect(r.mermaid).toContain('No graph nodes');
  });

  it('renders initiative edges', () => {
    const r = buildFleetMermaid(
      [
        { id: 'INIT-002', kind: 'initiative', label: 'INIT-002', priority: 'P0' },
        { id: 'INIT-003', kind: 'initiative', label: 'INIT-003', priority: 'P0' },
        { id: 'GAP-360', kind: 'gap', label: 'GAP-360' },
      ],
      [
        { from: 'INIT-002', to: 'INIT-003', relation: 'related' },
        { from: 'INIT-002', to: 'GAP-360', relation: 'member' },
      ],
    );
    expect(r.nodeCount).toBe(3);
    expect(r.mermaid).toContain('flowchart TB');
    expect(r.mermaid).toContain('INIT_002');
    expect(r.mermaid).toContain('-->');
  });

  it('collapses to initiatives when graph is large', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      id: i < 3 ? `INIT-00${i}` : `GAP-${i}`,
      kind: i < 3 ? 'initiative' : 'gap',
      label: i < 3 ? `INIT-00${i}` : `GAP-${i}`,
    }));
    const r = buildFleetMermaid(nodes, []);
    expect(r.truncated).toBe(true);
    expect(r.nodeCount).toBe(3);
  });
});
