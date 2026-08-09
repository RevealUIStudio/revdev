import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FleetMapPanel from '../../components/fleet/FleetMapPanel';

const mockPayload = {
  jvRoot: 'mock-planning-root',
  snapshotPath: 'mock-planning-root/docs/tracker-snapshot.json',
  statePath: null,
  snapshot: {
    schema: 'tracker-snapshot-v1',
    generatedAt: '2026-08-08T00:00:00.000Z',
    initiatives: [
      {
        id: 'INIT-002',
        name: 'RevDev daily driver',
        priority: 'P0',
        state: 'active',
        progress: { gapsOpen: 3, gapsClosed: 1, gapsListed: 4 },
      },
    ],
    freeSurfaces: [{ id: 'GAP-154', priority: 'high', initiativeId: 'INIT-002' }],
    nodes: [
      { id: 'INIT-002', kind: 'initiative', label: 'INIT-002', priority: 'P0' },
      { id: 'GAP-154', kind: 'gap', label: 'GAP-154' },
    ],
    edges: [{ from: 'INIT-002', to: 'GAP-154', relation: 'member' }],
  },
  state: null,
  generatedAt: '2026-08-08T00:00:00.000Z',
  freeSurfaceCount: 1,
  initiativeCount: 1,
  nodeCount: 2,
  edgeCount: 1,
};

vi.mock('../../lib/fleet-map', () => ({
  readFleetMap: vi.fn(),
}));

import { readFleetMap } from '../../lib/fleet-map';

describe('FleetMapPanel', () => {
  beforeEach(() => {
    vi.mocked(readFleetMap).mockReset();
  });

  it('renders initiative and free surface from snapshot', async () => {
    vi.mocked(readFleetMap).mockResolvedValue(mockPayload);
    render(<FleetMapPanel />);
    await waitFor(() => {
      expect(screen.getByText('GAP-154')).toBeInTheDocument();
    });
    // INIT-002 appears in both initiative and free-surface rows
    expect(screen.getAllByText('INIT-002').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading', { name: 'Fleet map' })).toBeInTheDocument();
    expect(screen.getByText('RevDev daily driver')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Free surfaces/i })).toBeInTheDocument();
    expect(screen.getByTestId('fleet-map-mermaid')).toHaveTextContent('flowchart TB');
    expect(screen.getByTestId('fleet-map-mermaid')).toHaveTextContent('INIT_002');
  });

  it('shows error when snapshot missing', async () => {
    vi.mocked(readFleetMap).mockRejectedValue(new Error('tracker-snapshot.json not found'));
    render(<FleetMapPanel />);
    await waitFor(() => {
      expect(screen.getByText(/tracker-snapshot\.json not found/i)).toBeInTheDocument();
    });
  });
});
