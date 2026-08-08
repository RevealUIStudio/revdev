import { readFleetMapPayload } from './invoke';

/** tracker-snapshot-v1 + optional STATE.json payload from Tauri. */
export interface FleetMapPayload {
  jvRoot: string;
  snapshotPath: string;
  statePath: string | null;
  snapshot: {
    schema?: string;
    generatedAt?: string;
    initiatives?: unknown[];
    freeSurfaces?: unknown[];
    nodes?: unknown[];
    edges?: unknown[];
    [key: string]: unknown;
  };
  state: {
    schema?: string;
    generatedAt?: string;
    pointers?: Record<string, string>;
    freeSurfaces?: unknown[];
    [key: string]: unknown;
  } | null;
  generatedAt: string | null;
  freeSurfaceCount: number;
  initiativeCount: number;
  nodeCount: number;
  edgeCount: number;
}

export function readFleetMap(): Promise<FleetMapPayload> {
  return readFleetMapPayload<FleetMapPayload>();
}
