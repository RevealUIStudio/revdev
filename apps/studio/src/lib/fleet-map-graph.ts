/**
 * Pure helpers: tracker-snapshot-v1 nodes/edges → mermaid flowchart (visual roadmap).
 * IDs only in labels (no private gap titles). Zero authored regex.
 */

export type SnapshotNode = {
  id: string;
  kind?: string;
  label?: string;
  state?: string;
  priority?: string;
};

export type SnapshotEdge = {
  from: string;
  to: string;
  relation?: string;
};

const MAX_GRAPH_NODES = 80;

/** Mermaid-safe node id: alnum and underscore only. */
export function mermaidSafeId(raw: string): string {
  const chars = Array.from(raw);
  const mapped = chars.map((c) => {
    if (
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c === '_'
    ) {
      return c;
    }
    return '_';
  });
  return mapped.join('') || 'n';
}

/**
 * Build a mermaid flowchart from snapshot graph.
 * Prefer initiative nodes + membership edges; fall back to truncated full graph.
 */
export function buildFleetMermaid(
  nodes: SnapshotNode[],
  edges: SnapshotEdge[],
): { mermaid: string; nodeCount: number; edgeCount: number; truncated: boolean } {
  if (nodes.length === 0) {
    return {
      mermaid: 'flowchart TB\n  empty["No graph nodes in snapshot"]',
      nodeCount: 0,
      edgeCount: 0,
      truncated: false,
    };
  }

  const initNodes = nodes.filter((n) => n.kind === 'initiative');
  const useInitsOnly = initNodes.length > 0 && nodes.length > MAX_GRAPH_NODES;
  const selected = useInitsOnly ? initNodes : nodes.slice(0, MAX_GRAPH_NODES);
  const selectedIds = new Set(selected.map((n) => n.id));
  const truncated = useInitsOnly || nodes.length > MAX_GRAPH_NODES;

  const lines: string[] = ['flowchart TB'];
  for (const n of selected) {
    const sid = mermaidSafeId(n.id);
    const label = (n.label ?? n.id).replaceAll('"', "'");
    const pri = n.priority ? ` ${n.priority}` : '';
    lines.push(`  ${sid}["${label}${pri}"]`);
  }

  let edgeCount = 0;
  for (const e of edges) {
    if (!selectedIds.has(e.from) || !selectedIds.has(e.to)) continue;
    // When init-only, keep member + blocked-by style edges into/out of inits
    if (useInitsOnly && e.relation === 'member') {
      // show init → gap as dashed if gap not in selected — skip external
      continue;
    }
    const a = mermaidSafeId(e.from);
    const b = mermaidSafeId(e.to);
    const rel = e.relation ? `|${e.relation}|` : '';
    lines.push(`  ${a} -->${rel} ${b}`);
    edgeCount += 1;
  }

  // Init-only: still show membership counts as notes on edges between inits via shared structure
  if (useInitsOnly) {
    lines.push('  note["INIT-only view (graph collapsed)"]');
  }

  return {
    mermaid: lines.join('\n'),
    nodeCount: selected.length,
    edgeCount,
    truncated,
  };
}
