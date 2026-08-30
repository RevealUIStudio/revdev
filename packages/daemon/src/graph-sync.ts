/**
 * GAP-349 P5b — Electric down-sync + hub anti-entropy into the PGlite replica.
 *
 * Spec §8.2: Electric is the DOWN direction (read-only shapes). Writes still
 * go outbox-up. Class-1/2 merge SQL applies hub rows; Electric *delete*
 * operations are skipped because kg edges/nodes are invalidate-not-delete.
 *
 * Does not log ELECTRIC_SECRET or connection URLs.
 */

import { hostname } from 'node:os';
import type { PGlite } from '@electric-sql/pglite';
import { createLogger } from '@revealui/utils/logger';
import { resolvePostgresUrl } from './neon.js';

const log = createLogger({ service: 'revdev-daemon-graph-sync' });

const SHAPE_TABLES = ['kg_nodes', 'kg_edges'] as const;
const SNAPSHOT_TABLES = [
  'kg_episodes',
  'kg_nodes',
  'kg_edges',
  'kg_edge_episodes',
  'kg_node_aliases',
] as const;
const MAX_REPOS = 32;
const MAX_SHAPE_PAGES = 40;
const REPO_ID = /^[a-zA-Z0-9._-]{1,128}$/;

export type ShapeTable = (typeof SHAPE_TABLES)[number];
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

export interface ShapeMessage {
  headers?: { operation?: string; control?: string };
  value?: Record<string, unknown>;
  key?: unknown;
}

export interface ShapePage {
  messages: ShapeMessage[];
  offset?: string;
  handle?: string;
  upToDate: boolean;
}

export interface GraphSyncDeps {
  fetchShapePage?: (url: URL) => Promise<ShapePage>;
  snapshotTable?: (table: SnapshotTable, repos: string[]) => Promise<Record<string, unknown>[]>;
}

export interface GraphSyncPullResult {
  siteId: string;
  repos: string[];
  electricConfigured: boolean;
  hubConfigured: boolean;
  applied: number;
  skippedDeletes: number;
  errors: number;
  electric: Record<string, { pages: number; applied: number }>;
  snapshot: Record<string, { rows: number; applied: number }>;
  reason?: string;
}

export function resolveElectricServiceUrl(): string {
  const raw = process.env.ELECTRIC_SERVICE_URL?.trim() || process.env.ELECTRIC_URL?.trim() || '';
  return raw.replace(/\/+$/, '');
}

export function isRepoIdentifier(value: string): boolean {
  return REPO_ID.test(value);
}

export function sanitizeRepos(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!isRepoIdentifier(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= MAX_REPOS) break;
  }
  return out;
}

export async function ensureGraphSiteId(db: PGlite, preferred?: string): Promise<string> {
  const existing = await db.query<{ site_id: string }>(
    `SELECT site_id FROM graph_site WHERE singleton = $1`,
    ['local'],
  );
  const found = existing.rows[0]?.site_id?.trim();
  if (found) return found;
  const siteId =
    preferred?.trim() || process.env.REVDEV_KG_SITE_ID?.trim() || `daemon:${hostname()}`;
  await db.query(
    `INSERT INTO graph_site (singleton, site_id) VALUES ($1, $2)
     ON CONFLICT (singleton) DO NOTHING`,
    ['local', siteId],
  );
  const again = await db.query<{ site_id: string }>(
    `SELECT site_id FROM graph_site WHERE singleton = $1`,
    ['local'],
  );
  return again.rows[0]?.site_id?.trim() || siteId;
}

export async function resolveSyncRepos(
  db: PGlite,
  params: Record<string, unknown>,
): Promise<string[]> {
  const fromParams = sanitizeRepos(params.repos);
  if (fromParams.length > 0) return fromParams;
  const envList = process.env.REVDEV_KG_REPOS?.split(',') ?? [];
  const fromEnv = sanitizeRepos(envList);
  if (fromEnv.length > 0) return fromEnv;
  const roots = await db.query<{ real_path: string }>(`SELECT real_path FROM project_roots`);
  const fromRoots: string[] = [];
  for (const row of roots.rows) {
    const base = row.real_path.split('/').filter(Boolean).at(-1);
    if (base && isRepoIdentifier(base) && !fromRoots.includes(base)) fromRoots.push(base);
    if (fromRoots.length >= MAX_REPOS) break;
  }
  return fromRoots;
}

function electricWhere(repos: string[]): string | undefined {
  if (repos.length === 0) return undefined;
  const quoted = repos.map((r) => `'${r}'`).join(',');
  return `repo IN (${quoted})`;
}

function headerValue(headers: Headers, name: string): string | undefined {
  const direct = headers.get(name);
  if (direct) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseShapeBody(body: unknown): ShapeMessage[] {
  if (Array.isArray(body)) return body as ShapeMessage[];
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? (parsed as ShapeMessage[]) : [];
    }
    const messages: ShapeMessage[] = [];
    for (const line of trimmed.split('\n')) {
      if (!line.trim()) continue;
      messages.push(JSON.parse(line) as ShapeMessage);
    }
    return messages;
  }
  return [];
}

export async function defaultFetchShapePage(url: URL): Promise<ShapePage> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`electric shape HTTP ${response.status}`);
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  const messages = parseShapeBody(body);
  const upToDate = messages.some(
    (m) => m.headers?.control === 'up-to-date' || m.headers?.control === 'must-refetch',
  );
  return {
    messages,
    offset: headerValue(response.headers, 'electric-offset'),
    handle: headerValue(response.headers, 'electric-handle'),
    upToDate,
  };
}

function asIso(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  return undefined;
}

export async function applyHubRow(
  db: PGlite,
  table: SnapshotTable,
  row: Record<string, unknown>,
): Promise<void> {
  switch (table) {
    case 'kg_episodes': {
      const id = asText(pick(row, 'id'));
      const episodeType = asText(pick(row, 'episode_type', 'episodeType'));
      const source = asText(pick(row, 'source'));
      const siteId = asText(pick(row, 'site_id', 'siteId'));
      const referenceTime = asIso(pick(row, 'reference_time', 'referenceTime'));
      if (!id || !episodeType || !source || !siteId || !referenceTime) return;
      await db.query(
        `INSERT INTO kg_episodes (id, episode_type, source, site_id, content, content_ref, reference_time)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          episodeType,
          source,
          siteId,
          asText(pick(row, 'content')),
          JSON.stringify(asJson(pick(row, 'content_ref', 'contentRef'))),
          referenceTime,
        ],
      );
      return;
    }
    case 'kg_nodes': {
      const id = asText(pick(row, 'id'));
      const kind = asText(pick(row, 'kind'));
      const name = asText(pick(row, 'name'));
      const naturalKey = asText(pick(row, 'natural_key', 'naturalKey'));
      const firstSeen =
        asIso(pick(row, 'first_seen_at', 'firstSeenAt')) ?? new Date().toISOString();
      const lastConfirmed = asIso(pick(row, 'last_confirmed_at', 'lastConfirmedAt')) ?? firstSeen;
      if (!id || !kind || !name || !naturalKey) return;
      const searchText = asText(pick(row, 'search_text', 'searchText')) ?? `${name} ${naturalKey}`;
      await db.query(
        `INSERT INTO kg_nodes
           (id, kind, name, natural_key, repo, summary, search_text, attributes,
            first_seen_at, last_confirmed_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz, $11::timestamptz)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           repo = COALESCE(EXCLUDED.repo, kg_nodes.repo),
           summary = COALESCE(EXCLUDED.summary, kg_nodes.summary),
           search_text = EXCLUDED.search_text,
           attributes = kg_nodes.attributes || EXCLUDED.attributes,
           first_seen_at = LEAST(kg_nodes.first_seen_at, EXCLUDED.first_seen_at),
           last_confirmed_at = GREATEST(kg_nodes.last_confirmed_at, EXCLUDED.last_confirmed_at),
           deleted_at = LEAST(kg_nodes.deleted_at, EXCLUDED.deleted_at)`,
        [
          id,
          kind,
          name,
          naturalKey,
          asText(pick(row, 'repo')),
          asText(pick(row, 'summary')),
          searchText,
          JSON.stringify(asJson(pick(row, 'attributes'))),
          firstSeen,
          lastConfirmed,
          asIso(pick(row, 'deleted_at', 'deletedAt')),
        ],
      );
      return;
    }
    case 'kg_edges': {
      const id = asText(pick(row, 'id'));
      const sourceId = asText(pick(row, 'source_id', 'sourceId'));
      const targetId = asText(pick(row, 'target_id', 'targetId'));
      const relation = asText(pick(row, 'relation'));
      const fact = asText(pick(row, 'fact'));
      const validAt = asIso(pick(row, 'valid_at', 'validAt')) ?? new Date().toISOString();
      if (!id || !sourceId || !targetId || !relation || !fact) return;
      await db.query(
        `INSERT INTO kg_edges
           (id, source_id, target_id, relation, fact, repo, attributes, valid_at, invalid_at, expired_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz, $10::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          sourceId,
          targetId,
          relation,
          fact,
          asText(pick(row, 'repo')),
          JSON.stringify(asJson(pick(row, 'attributes'))),
          validAt,
          asIso(pick(row, 'invalid_at', 'invalidAt')),
          asIso(pick(row, 'expired_at', 'expiredAt')),
        ],
      );
      const invalidAt = asIso(pick(row, 'invalid_at', 'invalidAt'));
      if (invalidAt) {
        await db.query(
          `UPDATE kg_edges SET invalid_at = LEAST(invalid_at, $2::timestamptz) WHERE id = $1`,
          [id, invalidAt],
        );
      }
      const expiredAt = asIso(pick(row, 'expired_at', 'expiredAt'));
      if (expiredAt) {
        await db.query(
          `UPDATE kg_edges SET expired_at = LEAST(expired_at, $2::timestamptz) WHERE id = $1`,
          [id, expiredAt],
        );
      }
      return;
    }
    case 'kg_edge_episodes': {
      const edgeId = asText(pick(row, 'edge_id', 'edgeId'));
      const episodeId = asText(pick(row, 'episode_id', 'episodeId'));
      if (!edgeId || !episodeId) return;
      await db.query(
        `INSERT INTO kg_edge_episodes (edge_id, episode_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [edgeId, episodeId],
      );
      return;
    }
    case 'kg_node_aliases': {
      const alias = asText(pick(row, 'alias'));
      const nodeId = asText(pick(row, 'node_id', 'nodeId'));
      if (!alias || !nodeId) return;
      await db.query(
        `INSERT INTO kg_node_aliases (alias, node_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [alias, nodeId],
      );
    }
  }
}

function isDeleteOp(operation: string | undefined): boolean {
  if (!operation) return false;
  const op = operation.toLowerCase();
  return op === 'delete' || op === 'remove';
}

async function loadCursor(
  db: PGlite,
  table: string,
): Promise<{ handle: string | null; offset: string }> {
  const rows = await db.query<{ handle: string | null; shape_offset: string }>(
    `SELECT handle, shape_offset FROM kg_shape_cursors WHERE table_name = $1`,
    [table],
  );
  return { handle: rows.rows[0]?.handle ?? null, offset: rows.rows[0]?.shape_offset ?? '-1' };
}

async function saveCursor(
  db: PGlite,
  table: string,
  handle: string | undefined,
  offset: string | undefined,
  error?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO kg_shape_cursors (table_name, handle, shape_offset, last_pulled_at, last_error)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (table_name) DO UPDATE SET
       handle = COALESCE(EXCLUDED.handle, kg_shape_cursors.handle),
       shape_offset = EXCLUDED.shape_offset,
       last_pulled_at = now(),
       last_error = EXCLUDED.last_error`,
    [table, handle ?? null, offset ?? '-1', error ?? null],
  );
}

function shapeUrl(table: ShapeTable, repos: string[], offset: string, handle: string | null): URL {
  const base = resolveElectricServiceUrl();
  const url = new URL(`${base}/v1/shape`);
  url.searchParams.set('table', table);
  url.searchParams.set('offset', offset);
  if (handle) url.searchParams.set('handle', handle);
  const secret = process.env.ELECTRIC_SECRET?.trim();
  if (secret) url.searchParams.set('secret', secret);
  const sourceId = process.env.ELECTRIC_SOURCE_ID?.trim();
  if (sourceId) url.searchParams.set('source_id', sourceId);
  const where = electricWhere(repos);
  if (where) url.searchParams.set('where', where);
  return url;
}

async function pullShapeTable(
  db: PGlite,
  table: ShapeTable,
  repos: string[],
  deps: GraphSyncDeps,
  stats: { applied: number; skippedDeletes: number; errors: number },
): Promise<{ pages: number; applied: number }> {
  const fetchPage = deps.fetchShapePage ?? defaultFetchShapePage;
  let { handle, offset } = await loadCursor(db, table);
  let pages = 0;
  let applied = 0;
  try {
    for (let i = 0; i < MAX_SHAPE_PAGES; i += 1) {
      const page = await fetchPage(shapeUrl(table, repos, offset, handle));
      pages += 1;
      if (page.handle) handle = page.handle;
      if (page.offset) offset = page.offset;
      for (const message of page.messages) {
        if (message.headers?.control) continue;
        if (isDeleteOp(message.headers?.operation)) {
          stats.skippedDeletes += 1;
          continue;
        }
        if (!message.value) continue;
        try {
          await applyHubRow(db, table, message.value);
          applied += 1;
          stats.applied += 1;
        } catch (err) {
          stats.errors += 1;
          log.warn('kg shape row apply failed', {
            table,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await saveCursor(db, table, handle ?? undefined, offset, undefined);
      if (page.upToDate || !page.offset) break;
    }
  } catch (err) {
    stats.errors += 1;
    const message = err instanceof Error ? err.message : String(err);
    await saveCursor(db, table, handle ?? undefined, offset, message);
    log.warn('kg shape pull failed', { table, error: message });
  }
  return { pages, applied };
}

async function defaultSnapshotTable(
  table: SnapshotTable,
  repos: string[],
): Promise<Record<string, unknown>[]> {
  const url = resolvePostgresUrl();
  if (!url) return [];
  const { createPool } = await import('@revealui/db/pool');
  const { makePoolExecutor } = await import('@revealui/knowledge-graph');
  const pool = createPool({
    connectionTimeoutMillis: 30_000,
    queryTimeoutMillis: 60_000,
    statementTimeoutMillis: 60_000,
    max: 2,
  });
  const exec = makePoolExecutor(pool);
  const repoFilter = repos.length > 0;
  switch (table) {
    case 'kg_nodes':
      return repoFilter
        ? exec.query(`SELECT * FROM kg_nodes WHERE repo = ANY($1)`, [repos])
        : exec.query(`SELECT * FROM kg_nodes`);
    case 'kg_edges':
      return repoFilter
        ? exec.query(`SELECT * FROM kg_edges WHERE repo = ANY($1)`, [repos])
        : exec.query(`SELECT * FROM kg_edges`);
    case 'kg_episodes':
      return repoFilter
        ? exec.query(
            `SELECT e.* FROM kg_episodes e
             WHERE e.id IN (
               SELECT ee.episode_id FROM kg_edge_episodes ee
               JOIN kg_edges g ON g.id = ee.edge_id
               WHERE g.repo = ANY($1)
             )`,
            [repos],
          )
        : exec.query(`SELECT * FROM kg_episodes`);
    case 'kg_edge_episodes':
      return repoFilter
        ? exec.query(
            `SELECT ee.* FROM kg_edge_episodes ee
             JOIN kg_edges g ON g.id = ee.edge_id
             WHERE g.repo = ANY($1)`,
            [repos],
          )
        : exec.query(`SELECT * FROM kg_edge_episodes`);
    case 'kg_node_aliases':
      return repoFilter
        ? exec.query(
            `SELECT a.* FROM kg_node_aliases a
             JOIN kg_nodes n ON n.id = a.node_id
             WHERE n.repo = ANY($1)`,
            [repos],
          )
        : exec.query(`SELECT * FROM kg_node_aliases`);
  }
}

export async function graphSyncPull(
  db: PGlite,
  params: Record<string, unknown>,
  deps: GraphSyncDeps = {},
): Promise<GraphSyncPullResult> {
  const siteId = await ensureGraphSiteId(db);
  const repos = await resolveSyncRepos(db, params);
  const electricConfigured = Boolean(resolveElectricServiceUrl());
  const hubConfigured = Boolean(resolvePostgresUrl());
  const stats = { applied: 0, skippedDeletes: 0, errors: 0 };
  const electric: GraphSyncPullResult['electric'] = {};
  const snapshot: GraphSyncPullResult['snapshot'] = {};

  if (!electricConfigured && !hubConfigured && !deps.fetchShapePage && !deps.snapshotTable) {
    return {
      siteId,
      repos,
      electricConfigured,
      hubConfigured,
      applied: 0,
      skippedDeletes: 0,
      errors: 0,
      electric,
      snapshot,
      reason: 'no ELECTRIC_SERVICE_URL and no POSTGRES_URL',
    };
  }
  if (repos.length === 0 && params.scope !== 'all') {
    return {
      siteId,
      repos,
      electricConfigured,
      hubConfigured,
      applied: 0,
      skippedDeletes: 0,
      errors: 0,
      electric,
      snapshot,
      reason: 'no repos (pass repos[], REVDEV_KG_REPOS, project_roots, or scope=all)',
    };
  }

  if (electricConfigured || deps.fetchShapePage) {
    for (const table of SHAPE_TABLES) {
      electric[table] = await pullShapeTable(db, table, repos, deps, stats);
    }
  }

  if (hubConfigured || deps.snapshotTable) {
    const snap = deps.snapshotTable ?? defaultSnapshotTable;
    for (const table of SNAPSHOT_TABLES) {
      try {
        const rows = await snap(table, repos);
        let applied = 0;
        for (const row of rows) {
          try {
            await applyHubRow(db, table, row);
            applied += 1;
            stats.applied += 1;
          } catch (err) {
            stats.errors += 1;
            log.warn('kg snapshot row apply failed', {
              table,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        snapshot[table] = { rows: rows.length, applied };
      } catch (err) {
        stats.errors += 1;
        snapshot[table] = { rows: 0, applied: 0 };
        log.warn('kg snapshot failed', {
          table,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    siteId,
    repos,
    electricConfigured,
    hubConfigured,
    applied: stats.applied,
    skippedDeletes: stats.skippedDeletes,
    errors: stats.errors,
    electric,
    snapshot,
  };
}
