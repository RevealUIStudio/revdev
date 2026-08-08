import { useCallback, useEffect, useMemo, useState } from 'react';
import { type FleetMapPayload, readFleetMap } from '../../lib/fleet-map';
import Button from '../adapters/Button';
import ErrorAlert from '../adapters/ErrorAlert';
import PanelHeader from '../adapters/PanelHeader';

type InitRow = {
  id: string;
  name?: string;
  slug?: string;
  state?: string;
  priority?: string;
  progress?: {
    gapsOpen?: number;
    gapsClosed?: number;
    gapsListed?: number;
    lanesActive?: number;
    lanesPaused?: number;
  };
};

type FreeRow = {
  id: string;
  kind?: string;
  priority?: string;
  initiativeId?: string;
};

function asInits(snapshot: FleetMapPayload['snapshot']): InitRow[] {
  const raw = snapshot.initiatives;
  if (!Array.isArray(raw)) return [];
  return raw as InitRow[];
}

function asFree(snapshot: FleetMapPayload['snapshot']): FreeRow[] {
  const raw = snapshot.freeSurfaces;
  if (!Array.isArray(raw)) return [];
  return raw as FreeRow[];
}

function progressPct(p: InitRow['progress']): number | null {
  if (!p) return null;
  const listed = p.gapsListed ?? 0;
  const closed = p.gapsClosed ?? 0;
  if (listed <= 0) return null;
  return Math.round((closed / listed) * 100);
}

export default function FleetMapPanel() {
  const [data, setData] = useState<FleetMapPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await readFleetMap();
      setData(payload);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const inits = useMemo(() => (data ? asInits(data.snapshot) : []), [data]);
  const free = useMemo(() => (data ? asFree(data.snapshot) : []), [data]);

  return (
    <div className="space-y-6">
      <PanelHeader
        title="Fleet map"
        action={
          <Button variant="secondary" onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
        }
      />

      <p className="text-sm text-fg-muted">
        Read-only view of the private TRACKER snapshot (initiatives, free surfaces, graph counts).
        Agents keep YAML SSOT; this panel never writes the board.
      </p>

      <ErrorAlert message={error} />

      {loading && !data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-3" />
          ))}
        </div>
      ) : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Initiatives" value={String(data.initiativeCount)} />
            <Stat label="Nodes" value={String(data.nodeCount)} />
            <Stat label="Edges" value={String(data.edgeCount)} />
            <Stat label="Free surfaces" value={String(data.freeSurfaceCount)} />
          </div>

          <div className="rounded-lg border border-edge bg-surface-1 px-4 py-3 text-xs text-fg-muted">
            <div>
              Snapshot:{' '}
              <span className="font-mono text-fg">{data.generatedAt ?? 'unknown time'}</span>
            </div>
            <div className="mt-1 truncate font-mono" title={data.snapshotPath}>
              {data.snapshotPath}
            </div>
            {data.statePath ? (
              <div className="mt-1 truncate font-mono" title={data.statePath}>
                STATE: {data.statePath}
              </div>
            ) : (
              <div className="mt-1">STATE.json not present (run tracker sync).</div>
            )}
          </div>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Initiatives
            </h2>
            <div className="overflow-x-auto rounded-lg border border-edge">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead className="bg-surface-2 text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Id</th>
                    <th className="px-3 py-2 font-medium">Pri</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2 font-medium">Open / listed</th>
                    <th className="px-3 py-2 font-medium">%</th>
                    <th className="px-3 py-2 font-medium">Name</th>
                  </tr>
                </thead>
                <tbody>
                  {inits.map((init) => {
                    const pct = progressPct(init.progress);
                    return (
                      <tr key={init.id} className="border-t border-edge">
                        <td className="px-3 py-2 font-mono text-xs">{init.id}</td>
                        <td className="px-3 py-2">{init.priority ?? '—'}</td>
                        <td className="px-3 py-2">{init.state ?? '—'}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {init.progress?.gapsOpen ?? '—'} / {init.progress?.gapsListed ?? '—'}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{pct === null ? '—' : `${pct}%`}</td>
                        <td className="px-3 py-2 text-fg-muted">{init.name ?? init.slug ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Free surfaces (top {Math.min(free.length, 20)})
            </h2>
            <div className="overflow-x-auto rounded-lg border border-edge">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <thead className="bg-surface-2 text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Gap</th>
                    <th className="px-3 py-2 font-medium">Pri</th>
                    <th className="px-3 py-2 font-medium">Init</th>
                  </tr>
                </thead>
                <tbody>
                  {free.slice(0, 20).map((row) => (
                    <tr key={row.id} className="border-t border-edge">
                      <td className="px-3 py-2 font-mono text-xs">{row.id}</td>
                      <td className="px-3 py-2">{row.priority ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{row.initiativeId ?? '—'}</td>
                    </tr>
                  ))}
                  {free.length === 0 ? (
                    <tr>
                      <td className="px-3 py-3 text-fg-muted" colSpan={3}>
                        No free surfaces in snapshot.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {data.state && typeof data.state === 'object' && data.state !== null ? (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Session STATE (pointers)
              </h2>
              <pre className="max-h-48 overflow-auto rounded-lg border border-edge bg-surface-2 p-3 text-xs text-fg-muted">
                {JSON.stringify(
                  {
                    schema: (data.state as { schema?: string }).schema,
                    generatedAt: (data.state as { generatedAt?: string }).generatedAt,
                    pointers: (data.state as { pointers?: unknown }).pointers,
                    freeSurfaces: (
                      (data.state as { freeSurfaces?: unknown[] }).freeSurfaces || []
                    ).slice(0, 5),
                  },
                  null,
                  2,
                )}
              </pre>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-1 px-4 py-3">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">{value}</div>
    </div>
  );
}
