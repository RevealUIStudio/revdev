/**
 * GAP-349 P5 leftover — Layer-3 multi-agent-memory → kg episodes.
 *
 * Reads `shared_facts` (hub) or an injected fact source, runs Layer 3
 * reconciliation (`@revealui/ai/memory` heuristic, optional LLM via
 * `@revealui/ai`), and `ingestEpisode`s canonical facts. Superseded facts
 * invalidate prior edges — never delete them.
 *
 * Scheduled from `onDaemonStarted`. Disabled when
 * REVDEV_KG_RECONCILE_INTERVAL_MS=0 or when no hub/injected source exists.
 * Does not fire a prod cron.
 */

import type { PGlite } from '@electric-sql/pglite';
import { applyOp, ingestEpisode, makeExecutor, makePoolExecutor } from '@revealui/knowledge-graph';
import { createLogger } from '@revealui/utils/logger';
import { onDaemonStarted, onDaemonStopping } from './eviction.js';
import { ensureGraphSiteId } from './graph-sync.js';
import { resolvePostgresUrl } from './neon.js';

const log = createLogger({ service: 'revdev-daemon-graph-reconcile' });

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_FACTS = 200;
const CURSOR_SOURCE = 'shared_facts';

export interface SharedFactRow {
  id: string;
  agentId: string;
  content: string;
  factType: string;
  confidence: number;
  tags: string[];
  sourceRef?: Record<string, unknown> | null;
  supersededBy?: string | null;
  createdAt?: string;
  sessionId?: string;
}

export interface ReconciledMemory {
  content: string;
  type: string;
  sourceFactIds: string[];
  confidence: number;
}

export interface Contradiction {
  factIds: string[];
  description: string;
  resolution: string;
}

export interface ReconciliationResult {
  canonicalFacts: ReconciledMemory[];
  contradictions: Contradiction[];
  duplicates: string[][];
  summary: string;
}

export type SharedFactFetcher = (opts: {
  sessionId?: string;
  after?: { createdAt: string; id: string } | null;
  limit: number;
}) => Promise<SharedFactRow[]>;

export type Layer3ReconcileFn = (facts: SharedFactRow[]) => Promise<ReconciliationResult>;

export interface GraphReconcileDeps {
  fetchFacts?: SharedFactFetcher;
  reconcile?: Layer3ReconcileFn;
  complete?: (prompt: string, userText: string) => Promise<string>;
}

export interface GraphReconcileResult {
  hub: boolean;
  fetched: number;
  ingested: number;
  skipped: number;
  invalidatedEdges: number;
  contradictions: number;
  summary: string;
  reason?: string;
}

function asSharedFactInput(row: SharedFactRow) {
  return {
    id: row.id,
    agentId: row.agentId,
    content: row.content,
    factType: row.factType,
    confidence: row.confidence,
    tags: row.tags,
    sourceRef: row.sourceRef,
  };
}

/** Local copy of `@revealui/ai/memory` reconcileHeuristic (Layer 3 production path). */
export function reconcileHeuristicLocal(facts: SharedFactRow[]): ReconciliationResult {
  const seen = new Map<string, string[]>();
  for (const fact of facts) {
    const normalized = fact.content.toLowerCase().trim();
    const existing = seen.get(normalized);
    if (existing) existing.push(fact.id);
    else seen.set(normalized, [fact.id]);
  }
  const canonicalFacts: ReconciledMemory[] = [];
  const duplicates: string[][] = [];
  for (const [, ids] of seen) {
    if (ids.length > 1) duplicates.push(ids);
    const sourceFact = facts.find((f) => f.id === ids[0]);
    if (!sourceFact) continue;
    const memoryType =
      sourceFact.factType === 'bug' || sourceFact.factType === 'warning' ? 'warning' : 'fact';
    canonicalFacts.push({
      content: sourceFact.content,
      type: memoryType,
      sourceFactIds: ids,
      confidence: sourceFact.confidence,
    });
  }
  return {
    canonicalFacts,
    contradictions: [],
    duplicates,
    summary: `Reconciled ${facts.length} facts into ${canonicalFacts.length} canonical facts (${duplicates.length} duplicates).`,
  };
}

async function importAiSubpath(subpath: string): Promise<Record<string, unknown>> {
  return (await import(`@revealui/ai/${subpath}`)) as Record<string, unknown>;
}

async function layer3Reconcile(
  facts: SharedFactRow[],
  deps: GraphReconcileDeps,
): Promise<ReconciliationResult> {
  if (deps.reconcile) return deps.reconcile(facts);
  if (deps.complete) {
    try {
      const mod = (await importAiSubpath('memory/services')) as {
        buildReconciliationPrompt: (facts: ReturnType<typeof asSharedFactInput>[]) => string;
        parseReconciliationResponse: (
          response: string,
          facts: ReturnType<typeof asSharedFactInput>[],
        ) => ReconciliationResult;
      };
      const inputs = facts.map(asSharedFactInput);
      const raw = await deps.complete(mod.buildReconciliationPrompt(inputs), '');
      return mod.parseReconciliationResponse(raw, inputs);
    } catch (err) {
      log.warn('Layer-3 LLM reconcile fell back to heuristic', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    const mod = (await importAiSubpath('memory/services')) as {
      reconcileHeuristic: (facts: ReturnType<typeof asSharedFactInput>[]) => ReconciliationResult;
    };
    return mod.reconcileHeuristic(facts.map(asSharedFactInput));
  } catch {
    return reconcileHeuristicLocal(facts);
  }
}

async function defaultFetchSharedFacts(opts: {
  sessionId?: string;
  after?: { createdAt: string; id: string } | null;
  limit: number;
}): Promise<SharedFactRow[]> {
  const url = resolvePostgresUrl();
  if (!url) return [];
  const { createPool } = await import('@revealui/db/pool');
  const pool = createPool({
    connectionTimeoutMillis: 30_000,
    queryTimeoutMillis: 60_000,
    statementTimeoutMillis: 60_000,
    max: 2,
  });
  const exec = makePoolExecutor(pool);
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.sessionId) {
    params.push(opts.sessionId);
    where.push(`session_id = $${params.length}`);
  }
  if (opts.after?.createdAt) {
    params.push(opts.after.createdAt, opts.after.id);
    where.push(`(created_at, id) > ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  params.push(opts.limit);
  const sql = `SELECT id, agent_id, content, fact_type, confidence, tags, source_ref,
                      superseded_by, created_at, session_id
               FROM shared_facts
               ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at ASC, id ASC
               LIMIT $${params.length}`;
  const rows = await exec.query<{
    id: string;
    agent_id: string;
    content: string;
    fact_type: string;
    confidence: number | string;
    tags: unknown;
    source_ref: unknown;
    superseded_by: string | null;
    created_at: string;
    session_id: string;
  }>(sql, params);
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    content: row.content,
    factType: row.fact_type,
    confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence) || 1,
    tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : [],
    sourceRef:
      row.source_ref && typeof row.source_ref === 'object' && !Array.isArray(row.source_ref)
        ? (row.source_ref as Record<string, unknown>)
        : null,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    sessionId: row.session_id,
  }));
}

function kgExec(db: PGlite) {
  return makeExecutor({
    query: (text: string, params?: unknown[]) => db.query(text, params),
  });
}

function episodeSource(factIds: string[]): string {
  return `shared_facts:${[...factIds].sort().join('+')}`;
}

async function alreadyIngested(db: PGlite, source: string): Promise<boolean> {
  const exec = kgExec(db);
  const rows = await exec.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM kg_episodes WHERE source = $1`,
    [source],
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function invalidateEdgesForEpisodeSource(
  db: PGlite,
  source: string,
  invalidAt = new Date(),
): Promise<number> {
  const exec = kgExec(db);
  const edges = await exec.query<{ id: string }>(
    `SELECT g.id FROM kg_edges g
     JOIN kg_edge_episodes ee ON ee.edge_id = g.id
     JOIN kg_episodes e ON e.id = ee.episode_id
     WHERE e.source = $1
       AND (g.invalid_at IS NULL OR g.invalid_at > $2::timestamptz)`,
    [source, invalidAt.toISOString()],
  );
  let invalidated = 0;
  for (const edge of edges) {
    await applyOp(
      exec,
      { t: 'invalidate', edgeId: edge.id, invalidAt: invalidAt.toISOString() },
      { recordOutbox: true },
    );
    invalidated += 1;
  }
  return invalidated;
}

function conceptKey(content: string): string {
  const slug = content
    .toLowerCase()
    .trim()
    .slice(0, 80)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `shared-fact:${slug || 'untitled'}`;
}

export async function graphReconcile(
  db: PGlite,
  params: Record<string, unknown> = {},
  deps: GraphReconcileDeps = {},
): Promise<GraphReconcileResult> {
  const siteId = await ensureGraphSiteId(db);
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : undefined;
  const limit =
    typeof params.limit === 'number' ? Math.min(Math.max(1, params.limit), MAX_FACTS) : MAX_FACTS;
  const fetchFacts = deps.fetchFacts ?? defaultFetchSharedFacts;
  const hub = Boolean(resolvePostgresUrl()) || Boolean(deps.fetchFacts);

  const cursorRows = await db.query<{ last_created_at: string | null; last_id: string | null }>(
    `SELECT last_created_at, last_id FROM kg_reconcile_cursor WHERE source = $1`,
    [CURSOR_SOURCE],
  );
  const after =
    cursorRows.rows[0]?.last_created_at && cursorRows.rows[0]?.last_id
      ? { createdAt: cursorRows.rows[0].last_created_at, id: cursorRows.rows[0].last_id }
      : null;

  let facts: SharedFactRow[] = [];
  try {
    facts = await fetchFacts({ sessionId, after, limit });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `INSERT INTO kg_reconcile_cursor (source, last_run_at, last_error)
       VALUES ($1, now(), $2)
       ON CONFLICT (source) DO UPDATE SET last_run_at = now(), last_error = EXCLUDED.last_error`,
      [CURSOR_SOURCE, message],
    );
    return {
      hub,
      fetched: 0,
      ingested: 0,
      skipped: 0,
      invalidatedEdges: 0,
      contradictions: 0,
      summary: '',
      reason: message,
    };
  }

  if (!hub && facts.length === 0) {
    return {
      hub: false,
      fetched: 0,
      ingested: 0,
      skipped: 0,
      invalidatedEdges: 0,
      contradictions: 0,
      summary: '',
      reason: 'no POSTGRES_URL and no injected shared_facts source',
    };
  }

  const superseded = facts.filter((f) => f.supersededBy);
  const active = facts.filter((f) => !f.supersededBy);
  let invalidatedEdges = 0;
  for (const fact of superseded) {
    invalidatedEdges += await invalidateEdgesForEpisodeSource(db, episodeSource([fact.id]));
  }

  const reconciled =
    active.length > 0 ? await layer3Reconcile(active, deps) : reconcileHeuristicLocal([]);
  let ingested = 0;
  let skipped = 0;

  for (const canonical of reconciled.canonicalFacts) {
    const source = episodeSource(canonical.sourceFactIds);
    if (await alreadyIngested(db, source)) {
      skipped += 1;
      continue;
    }
    const name = canonical.content.slice(0, 80);
    await ingestEpisode(
      kgExec(db),
      {
        episode: {
          episodeType: 'memory',
          source,
          siteId,
          content: canonical.content,
          contentRef: {
            layer: 3,
            type: canonical.type,
            confidence: canonical.confidence,
            factIds: canonical.sourceFactIds,
          },
          referenceTime: new Date(),
        },
        nodes: [
          {
            kind: 'concept',
            name,
            naturalKey: conceptKey(canonical.content),
            summary: canonical.content,
          },
        ],
        edges: [],
      },
      { recordOutbox: true },
    );
    ingested += 1;
  }

  const last = facts.at(-1);
  await db.query(
    `INSERT INTO kg_reconcile_cursor (source, last_created_at, last_id, last_run_at, last_error, ingested)
     VALUES ($1, $2::timestamptz, $3, now(), NULL, $4)
     ON CONFLICT (source) DO UPDATE SET
       last_created_at = COALESCE(EXCLUDED.last_created_at, kg_reconcile_cursor.last_created_at),
       last_id = COALESCE(EXCLUDED.last_id, kg_reconcile_cursor.last_id),
       last_run_at = now(),
       last_error = NULL,
       ingested = kg_reconcile_cursor.ingested + EXCLUDED.ingested`,
    [CURSOR_SOURCE, last?.createdAt ?? null, last?.id ?? null, ingested],
  );

  return {
    hub,
    fetched: facts.length,
    ingested,
    skipped,
    invalidatedEdges,
    contradictions: reconciled.contradictions.length,
    summary: reconciled.summary,
  };
}

let reconcileTimer: NodeJS.Timeout | null = null;

export function reconcileIntervalMs(): number {
  const raw = process.env.REVDEV_KG_RECONCILE_INTERVAL_MS?.trim();
  if (raw === '0') return 0;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return DEFAULT_INTERVAL_MS;
}

export function startReconcileLoop(db: PGlite, deps: GraphReconcileDeps = {}): void {
  stopReconcileLoop();
  const interval = reconcileIntervalMs();
  if (interval <= 0) {
    log.info('kg Layer-3 reconcile loop disabled (interval 0)');
    return;
  }
  if (!resolvePostgresUrl() && !deps.fetchFacts) {
    log.info('kg Layer-3 reconcile loop idle (no hub)');
    return;
  }
  const firstDelay = Math.min(interval, 60_000);
  const tick = () => {
    void graphReconcile(db, {}, deps).catch((err) =>
      log.warn('kg Layer-3 reconcile failed', { error: String(err) }),
    );
  };
  setTimeout(tick, firstDelay).unref();
  reconcileTimer = setInterval(tick, interval);
  reconcileTimer.unref();
  log.info('kg Layer-3 reconcile loop armed', { intervalMs: interval, firstDelayMs: firstDelay });
}

export function stopReconcileLoop(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

onDaemonStarted(async (db) => {
  startReconcileLoop(db);
});

onDaemonStopping(() => {
  stopReconcileLoop();
});
