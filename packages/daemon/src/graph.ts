/**
 * graph.* handlers — offline-first knowledge-graph replica on daemon PGlite.
 *
 * GAP-349 P5 / spec §8.2: local kg_* tables + kg_outbox; reads and
 * ingestEpisode run against PGlite. graph.outbox.push replays unpushed ops
 * to the Neon hub when POSTGRES_URL is set (class-1/2 merge, no extra CRDT
 * library). P5b: Electric down-sync + hub anti-entropy live in graph-sync.ts.
 * Communities and Layer-3 reconcile stay later P5 slices.
 *
 * Extends `@revealui/knowledge-graph` (published 0.1.8; 0.1.9 pulls unpublished
 * `@revealui/ts-strada`). Do not fork DDL.
 */

import { hostname } from 'node:os';
import type { PGlite } from '@electric-sql/pglite';
import {
  applyOp,
  EDGE_RELATIONS,
  type EdgeInput,
  type EdgeRelation,
  ingestEpisode,
  type KgExecutor,
  type KgOp,
  kgAtTime,
  kgNeighbors,
  kgSearch,
  makeExecutor,
  makePoolExecutor,
  NODE_KINDS,
  type NodeInput,
  type NodeKind,
} from '@revealui/knowledge-graph';
import { resolveNaturalKey } from '@revealui/knowledge-graph/ingest';
import { createLogger } from '@revealui/utils/logger';
import { ensureGraphSiteId, graphSyncPull } from './graph-sync.js';
import { resolvePostgresUrl } from './neon.js';
import { registerHandler } from './server.js';

/** Lockstep with @revealui/knowledge-graph EpisodeType (0.1.8 has no EPISODE_TYPES export). */
const EPISODE_TYPES = [
  'code-scan',
  'git-commit',
  'doc',
  'agent-fact',
  'memory',
  'json',
  'manual',
] as const;
type EpisodeType = (typeof EPISODE_TYPES)[number];

const log = createLogger({ service: 'revdev-daemon-graph' });

const DEFAULT_CONTEXT_CHAR_BUDGET = 16_000;
const MAX_CONTEXT_CHAR_BUDGET = 200_000;
const MAX_BFS_DEPTH = 6;
const MAX_SEARCH_LIMIT = 100;

export function kgExecutorFromPglite(db: PGlite): KgExecutor {
  return makeExecutor({
    query: (text: string, params?: unknown[]) => db.query(text, params),
  });
}

export function resolveGraphSiteId(
  params: Record<string, unknown>,
  ctx?: { agentId?: string | null },
): string {
  const fromEnv = process.env.REVDEV_KG_SITE_ID?.trim();
  if (fromEnv) return fromEnv;
  if (typeof params.siteId === 'string' && params.siteId.trim()) return params.siteId.trim();
  if (ctx?.agentId) return `daemon:${ctx.agentId}`;
  return `daemon:${hostname()}`;
}

function asIsoDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function graphStatus(db: PGlite): Promise<{
  replica: 'pglite';
  tables: string[];
  nodes: number;
  edges: number;
  episodes: number;
  outboxPending: number;
  hubConfigured: boolean;
  electricConfigured: boolean;
  siteId: string;
}> {
  const exec = kgExecutorFromPglite(db);
  const siteId = await ensureGraphSiteId(db);
  const [nodes, edges, episodes, pending] = await Promise.all([
    exec.query<{ n: number }>('SELECT count(*)::int AS n FROM kg_nodes'),
    exec.query<{ n: number }>('SELECT count(*)::int AS n FROM kg_edges'),
    exec.query<{ n: number }>('SELECT count(*)::int AS n FROM kg_episodes'),
    exec.query<{ n: number }>('SELECT count(*)::int AS n FROM kg_outbox WHERE pushed_at IS NULL'),
  ]);
  return {
    replica: 'pglite',
    tables: [
      'kg_episodes',
      'kg_nodes',
      'kg_edges',
      'kg_edge_episodes',
      'kg_node_aliases',
      'kg_outbox',
    ],
    nodes: nodes[0]?.n ?? 0,
    edges: edges[0]?.n ?? 0,
    episodes: episodes[0]?.n ?? 0,
    outboxPending: pending[0]?.n ?? 0,
    hubConfigured: Boolean(resolvePostgresUrl()),
    electricConfigured: Boolean(
      process.env.ELECTRIC_SERVICE_URL?.trim() || process.env.ELECTRIC_URL?.trim(),
    ),
    siteId,
  };
}

export async function graphSearch(db: PGlite, params: Record<string, unknown>): Promise<unknown> {
  const exec = kgExecutorFromPglite(db);
  const query = typeof params.query === 'string' ? params.query : '';
  const limit =
    typeof params.limit === 'number' ? Math.min(Math.max(1, params.limit), MAX_SEARCH_LIMIT) : 20;
  const bfsDepth =
    typeof params.bfsDepth === 'number'
      ? Math.min(Math.max(1, params.bfsDepth), MAX_BFS_DEPTH)
      : undefined;
  const anchor =
    typeof params.anchor === 'string'
      ? params.anchor
      : typeof params.naturalKey === 'string'
        ? ((await resolveNaturalKey(exec, params.naturalKey)) ?? undefined)
        : undefined;
  return kgSearch(exec, {
    query,
    anchor,
    kinds: asKindList(params.kinds),
    relations: asRelationList(params.relations),
    at: asIsoDate(params.at),
    limit,
    bfsDepth,
  });
}

export async function graphNode(
  db: PGlite,
  params: Record<string, unknown>,
): Promise<{ node: Record<string, unknown> | null; facts: unknown[] }> {
  const exec = kgExecutorFromPglite(db);
  const naturalKey = typeof params.naturalKey === 'string' ? params.naturalKey : '';
  const id = await resolveNaturalKey(exec, naturalKey);
  if (!id) return { node: null, facts: [] };
  const rows = await exec.query<{
    id: string;
    kind: string;
    name: string;
    natural_key: string;
    repo: string | null;
    summary: string | null;
  }>('SELECT id, kind, name, natural_key, repo, summary FROM kg_nodes WHERE id = $1', [id]);
  const row = rows[0];
  const at = asIsoDate(params.at) ?? new Date();
  const facts = await kgAtTime(exec, id, at);
  return {
    node: row
      ? {
          id: row.id,
          kind: row.kind,
          name: row.name,
          naturalKey: row.natural_key,
          repo: row.repo,
          summary: row.summary,
        }
      : null,
    facts,
  };
}

export async function graphNeighbors(
  db: PGlite,
  params: Record<string, unknown>,
): Promise<unknown> {
  const exec = kgExecutorFromPglite(db);
  const naturalKey = typeof params.naturalKey === 'string' ? params.naturalKey : '';
  const id = await resolveNaturalKey(exec, naturalKey);
  if (!id) return { nodes: [], edges: [] };
  const depth =
    typeof params.depth === 'number' ? Math.min(Math.max(1, params.depth), MAX_BFS_DEPTH) : 1;
  return kgNeighbors(exec, id, {
    depth,
    relations: asRelationList(params.relations),
    at: asIsoDate(params.at),
  });
}

export async function graphAt(db: PGlite, params: Record<string, unknown>): Promise<unknown> {
  const exec = kgExecutorFromPglite(db);
  const naturalKey = typeof params.naturalKey === 'string' ? params.naturalKey : '';
  const at = asIsoDate(params.at);
  if (!at) throw new Error('graph.at requires at (ISO-8601)');
  const id = await resolveNaturalKey(exec, naturalKey);
  if (!id) return [];
  return kgAtTime(exec, id, at);
}

export async function graphContext(
  db: PGlite,
  params: Record<string, unknown>,
): Promise<{
  context: string;
  anchor: { id: string; naturalKey: string } | null;
  nodeCount: number;
  factCount: number;
  charBudget: number;
  charsUsed: number;
  truncated: boolean;
}> {
  const exec = kgExecutorFromPglite(db);
  const naturalKey = typeof params.naturalKey === 'string' ? params.naturalKey : '';
  const charBudget =
    typeof params.charBudget === 'number'
      ? Math.min(Math.max(1, params.charBudget), MAX_CONTEXT_CHAR_BUDGET)
      : DEFAULT_CONTEXT_CHAR_BUDGET;
  const depth =
    typeof params.depth === 'number' ? Math.min(Math.max(1, params.depth), MAX_BFS_DEPTH) : 2;
  const id = await resolveNaturalKey(exec, naturalKey);
  if (!id) {
    return {
      context: '',
      anchor: null,
      nodeCount: 0,
      factCount: 0,
      charBudget,
      charsUsed: 0,
      truncated: false,
    };
  }
  const neighbors = await kgNeighbors(exec, id, { depth, at: asIsoDate(params.at) });
  const lines: string[] = [`# Context for ${naturalKey} (depth=${depth})`, '', '## Nodes'];
  for (const n of neighbors.nodes) {
    lines.push(`- [${n.kind}] ${n.naturalKey} (${n.distance} hop)`);
  }
  lines.push('', '## Facts');
  for (const e of neighbors.edges) {
    lines.push(`- (${e.relation}) ${e.fact}`);
  }
  let charsUsed = 0;
  let truncated = false;
  const packed: string[] = [];
  for (const line of lines) {
    const added = line.length + 1;
    if (charsUsed + added > charBudget) {
      truncated = true;
      break;
    }
    packed.push(line);
    charsUsed += added;
  }
  return {
    context: packed.join('\n'),
    anchor: { id, naturalKey },
    nodeCount: neighbors.nodes.length,
    factCount: neighbors.edges.length,
    charBudget,
    charsUsed,
    truncated,
  };
}

export async function graphAddEpisode(
  db: PGlite,
  params: Record<string, unknown>,
  siteId: string,
): Promise<unknown> {
  const exec = kgExecutorFromPglite(db);
  const episodeType = parseEpisodeType(params.episodeType);
  const source = typeof params.source === 'string' ? params.source : 'daemon';
  const content = typeof params.content === 'string' ? params.content : '';
  const nodes = parseNodes(params.nodes);
  const edges = parseEdges(params.edges);
  const referenceTime = asIsoDate(params.referenceTime) ?? new Date();
  return ingestEpisode(
    exec,
    {
      episode: {
        episodeType,
        source,
        siteId,
        content,
        contentRef: isRecord(params.contentRef) ? params.contentRef : {},
        referenceTime,
      },
      nodes,
      edges,
    },
    { recordOutbox: true },
  );
}

export async function graphOutboxPush(db: PGlite): Promise<{
  pushed: number;
  pending: number;
  hub: boolean;
  error?: string;
}> {
  const exec = kgExecutorFromPglite(db);
  const pendingRows = await exec.query<{ seq: number; op: unknown }>(
    'SELECT seq, op FROM kg_outbox WHERE pushed_at IS NULL ORDER BY seq',
  );
  const hub = await tryHubExecutor();
  if (!hub) {
    return { pushed: 0, pending: pendingRows.length, hub: false };
  }
  let pushed = 0;
  for (const row of pendingRows) {
    try {
      await applyOp(hub, asKgOp(row.op), { recordOutbox: false });
      await exec.query('UPDATE kg_outbox SET pushed_at = now() WHERE seq = $1', [row.seq]);
      pushed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('kg_outbox push stopped', { seq: row.seq, error: message });
      return {
        pushed,
        pending: pendingRows.length - pushed,
        hub: true,
        error: message,
      };
    }
  }
  return { pushed, pending: 0, hub: true };
}

let cachedHub: KgExecutor | null | undefined;

async function tryHubExecutor(): Promise<KgExecutor | null> {
  if (cachedHub !== undefined) return cachedHub;
  const url = resolvePostgresUrl();
  if (!url) {
    cachedHub = null;
    return null;
  }
  try {
    const { createPool } = await import('@revealui/db/pool');
    const pool = createPool({
      connectionTimeoutMillis: 30_000,
      queryTimeoutMillis: 60_000,
      statementTimeoutMillis: 60_000,
      max: 2,
    });
    cachedHub = makePoolExecutor(pool);
    return cachedHub;
  } catch (err) {
    log.warn('knowledge-graph hub pool unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    cachedHub = null;
    return null;
  }
}

function asKgOp(value: unknown): KgOp {
  if (!value || typeof value !== 'object' || !('t' in value)) {
    throw new Error('kg_outbox.op is not a KgOp');
  }
  return value as KgOp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NODE_KIND_SET = new Set<string>(NODE_KINDS);
const EDGE_RELATION_SET = new Set<string>(EDGE_RELATIONS);
const EPISODE_TYPE_SET = new Set<string>(EPISODE_TYPES);

function parseEpisodeType(value: unknown): EpisodeType {
  if (typeof value === 'string' && EPISODE_TYPE_SET.has(value)) return value as EpisodeType;
  return 'agent-fact';
}

function asKindList(value: unknown): NodeKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kinds = value.filter((k): k is NodeKind => typeof k === 'string' && NODE_KIND_SET.has(k));
  return kinds.length > 0 ? kinds : undefined;
}

function asRelationList(value: unknown): EdgeRelation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rels = value.filter(
    (r): r is EdgeRelation => typeof r === 'string' && EDGE_RELATION_SET.has(r),
  );
  return rels.length > 0 ? rels : undefined;
}

function parseNodes(value: unknown): NodeInput[] {
  if (!Array.isArray(value)) return [];
  const nodes: NodeInput[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (typeof raw.kind !== 'string' || !NODE_KIND_SET.has(raw.kind)) continue;
    if (typeof raw.name !== 'string' || typeof raw.naturalKey !== 'string') continue;
    nodes.push({
      kind: raw.kind as NodeKind,
      name: raw.name,
      naturalKey: raw.naturalKey,
      repo: typeof raw.repo === 'string' ? raw.repo : null,
      summary: typeof raw.summary === 'string' ? raw.summary : null,
      attributes: isRecord(raw.attributes) ? raw.attributes : {},
    });
  }
  return nodes;
}

function parseEdges(value: unknown): EdgeInput[] {
  if (!Array.isArray(value)) return [];
  const edges: EdgeInput[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !isRecord(raw.source) || !isRecord(raw.target)) continue;
    if (typeof raw.relation !== 'string' || !EDGE_RELATION_SET.has(raw.relation)) continue;
    if (typeof raw.source.kind !== 'string' || !NODE_KIND_SET.has(raw.source.kind)) continue;
    if (typeof raw.target.kind !== 'string' || !NODE_KIND_SET.has(raw.target.kind)) continue;
    if (typeof raw.source.naturalKey !== 'string' || typeof raw.target.naturalKey !== 'string') {
      continue;
    }
    if (typeof raw.fact !== 'string') continue;
    edges.push({
      source: { kind: raw.source.kind as NodeKind, naturalKey: raw.source.naturalKey },
      target: { kind: raw.target.kind as NodeKind, naturalKey: raw.target.naturalKey },
      relation: raw.relation as EdgeRelation,
      fact: raw.fact,
      repo: typeof raw.repo === 'string' ? raw.repo : null,
    });
  }
  return edges;
}

registerHandler('graph.status', async (_params, db) => graphStatus(db));

registerHandler('graph.search', async (params, db) => graphSearch(db, params));

registerHandler('graph.node', async (params, db) => graphNode(db, params));

registerHandler('graph.neighbors', async (params, db) => graphNeighbors(db, params));

registerHandler('graph.at', async (params, db) => graphAt(db, params));

registerHandler('graph.context', async (params, db) => graphContext(db, params));

registerHandler('graph.addEpisode', async (params, db, ctx) =>
  graphAddEpisode(db, params, await ensureGraphSiteId(db, resolveGraphSiteId(params, ctx))),
);

registerHandler('graph.outbox.push', async (_params, db) => graphOutboxPush(db));

registerHandler('graph.sync.pull', async (params, db) => graphSyncPull(db, params));
