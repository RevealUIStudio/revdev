/**
 * GAP-349 P5 leftover — kg_communities (connected-component clusters + LLM summaries).
 *
 * Class-3 derived state: recomputed locally, never Electric-synced. Prior
 * community rows are invalidated (invalidated_at), never deleted.
 *
 * Clustering is deterministic union-find on the current graph. Summaries go
 * through an injected completer; production wires `@revealui/ai` (no
 * `@anthropic-ai/sdk`). Missing AI degrades to a template summary.
 */

import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { makeExecutor } from '@revealui/knowledge-graph';
import { createLogger } from '@revealui/utils/logger';

const log = createLogger({ service: 'revdev-daemon-graph-communities' });

const MAX_COMMUNITIES = 200;
const MAX_SUMMARY_NODES = 24;
const MAX_SUMMARY_FACTS = 40;

export type CommunityCompleter = (prompt: string, userText: string) => Promise<string>;

export interface GraphCommunity {
  id: string;
  name: string;
  summary: string;
  nodeIds: string[];
  nodeCount: number;
  algorithm: string;
  computedAt: string;
}

export interface GraphCommunitiesResult {
  communities: GraphCommunity[];
  computed: boolean;
  llm: boolean;
  invalidated: number;
}

export interface GraphCommunitiesDeps {
  complete?: CommunityCompleter;
}

export const COMMUNITY_SUMMARY_PROMPT = `You name and summarize a knowledge-graph community.
Return ONLY valid JSON: { "name": string, "summary": string }
Rules: name is 2-8 words; summary is 1-3 sentences; do not invent secrets.`;

function kgExec(db: PGlite) {
  return makeExecutor({
    query: (text: string, params?: unknown[]) => db.query(text, params),
  });
}

export function connectedComponents(
  nodeIds: string[],
  edges: Array<{ sourceId: string; targetId: string }>,
): string[][] {
  const parent = new Map<string, string>();
  for (const id of nodeIds) parent.set(id, id);

  const find = (id: string): string => {
    let cur = parent.get(id) ?? id;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur) ?? cur;
      parent.set(cur, parent.get(next) ?? next);
      cur = next;
    }
    return cur;
  };
  const union = (a: string, b: string) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent.set(pa, pb);
  };

  for (const edge of edges) {
    if (!parent.has(edge.sourceId) || !parent.has(edge.targetId)) continue;
    union(edge.sourceId, edge.targetId);
  }

  const groups = new Map<string, string[]>();
  for (const id of nodeIds) {
    const root = find(id);
    const list = groups.get(root) ?? [];
    list.push(id);
    groups.set(root, list);
  }
  return [...groups.values()]
    .map((ids) => [...ids].sort())
    .sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''));
}

export function communityIdFor(nodeIds: string[], computedAt?: string): string {
  const hash = createHash('sha256').update(['community', ...nodeIds].join('\n')).digest('hex');
  const stamp = computedAt ? `:${new Date(computedAt).getTime()}` : '';
  return `community:${hash.slice(0, 32)}${stamp}`;
}

function templateSummary(
  nodes: Array<{ name: string; kind: string; naturalKey: string }>,
  facts: string[],
): { name: string; summary: string } {
  const labels = nodes.slice(0, 4).map((n) => n.name || n.naturalKey);
  const name = labels.length > 0 ? labels.join(' / ') : 'empty community';
  const factBit = facts[0] ? ` Leading fact: ${facts[0]}` : '';
  return {
    name: name.slice(0, 120),
    summary: `${nodes.length} nodes (${nodes.map((n) => n.kind).join(', ') || 'none'}).${factBit}`,
  };
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

async function summarizeCommunity(
  nodes: Array<{ name: string; kind: string; naturalKey: string }>,
  facts: string[],
  complete?: CommunityCompleter,
): Promise<{ name: string; summary: string; llm: boolean }> {
  const fallback = templateSummary(nodes, facts);
  if (!complete) return { ...fallback, llm: false };
  const userText = [
    'Nodes:',
    ...nodes.map((n) => `- [${n.kind}] ${n.name} (${n.naturalKey})`),
    '',
    'Facts:',
    ...facts.map((f) => `- ${f}`),
  ].join('\n');
  try {
    const raw = await complete(COMMUNITY_SUMMARY_PROMPT, userText);
    const parsed = JSON.parse(extractJsonObject(raw)) as { name?: unknown; summary?: unknown };
    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : fallback.name;
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : fallback.summary;
    return { name: name.slice(0, 200), summary: summary.slice(0, 4000), llm: true };
  } catch (err) {
    log.warn('community LLM summary fell back to template', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...fallback, llm: false };
  }
}

export async function defaultCommunityCompleter(
  prompt: string,
  userText: string,
): Promise<string> {
  const { createLLMClientFromEnv } = (await import('@revealui/ai/llm/client')) as {
    createLLMClientFromEnv: () => { chat: (messages: Array<{ role: string; content: string }>) => Promise<{ content: string }> };
  };
  const client = createLLMClientFromEnv();
  const result = await client.chat([
    { role: 'system', content: prompt },
    { role: 'user', content: userText },
  ]);
  return result.content;
}

let cachedCompleter: CommunityCompleter | null | undefined;

async function resolveCompleter(injected?: CommunityCompleter): Promise<CommunityCompleter | undefined> {
  if (injected) return injected;
  if (process.env.REVDEV_KG_COMMUNITY_LLM === '0') return undefined;
  if (cachedCompleter !== undefined) return cachedCompleter ?? undefined;
  try {
    await import('@revealui/ai/llm/client');
    cachedCompleter = defaultCommunityCompleter;
    return cachedCompleter;
  } catch {
    cachedCompleter = null;
    return undefined;
  }
}

export async function listCommunities(db: PGlite, limit = 50): Promise<GraphCommunity[]> {
  const exec = kgExec(db);
  const rows = await exec.query<{
    id: string;
    name: string;
    summary: string | null;
    node_ids: unknown;
    node_count: number;
    algorithm: string;
    computed_at: string;
  }>(
    `SELECT id, name, summary, node_ids, node_count, algorithm, computed_at
     FROM kg_communities
     WHERE invalidated_at IS NULL
     ORDER BY node_count DESC, computed_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    summary: row.summary ?? '',
    nodeIds: parseNodeIds(row.node_ids),
    nodeCount: row.node_count,
    algorithm: row.algorithm,
    computedAt: row.computed_at,
  }));
}

function parseNodeIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      return [];
    }
  }
  return [];
}

export async function computeCommunities(
  db: PGlite,
  deps: GraphCommunitiesDeps = {},
): Promise<{ communities: GraphCommunity[]; llm: boolean; invalidated: number }> {
  const exec = kgExec(db);
  const nodes = await exec.query<{
    id: string;
    kind: string;
    name: string;
    natural_key: string;
  }>(
    `SELECT id, kind, name, natural_key FROM kg_nodes WHERE deleted_at IS NULL`,
  );
  const edges = await exec.query<{ source_id: string; target_id: string; fact: string }>(
    `SELECT source_id, target_id, fact FROM kg_edges
     WHERE invalid_at IS NULL AND expired_at IS NULL`,
  );

  const clusters = connectedComponents(
    nodes.map((n) => n.id),
    edges.map((e) => ({ sourceId: e.source_id, targetId: e.target_id })),
  ).slice(0, MAX_COMMUNITIES);

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const factsByNode = new Map<string, string[]>();
  for (const edge of edges) {
    for (const id of [edge.source_id, edge.target_id]) {
      const list = factsByNode.get(id) ?? [];
      if (list.length < MAX_SUMMARY_FACTS) list.push(edge.fact);
      factsByNode.set(id, list);
    }
  }

  const complete = await resolveCompleter(deps.complete);
  const computedAt = new Date().toISOString();
  const communities: GraphCommunity[] = [];
  let usedLlm = false;

  for (const memberIds of clusters) {
    const memberNodes = memberIds
      .map((id) => nodeById.get(id))
      .filter((n): n is (typeof nodes)[number] => n !== undefined)
      .slice(0, MAX_SUMMARY_NODES);
    const facts = [...new Set(memberIds.flatMap((id) => factsByNode.get(id) ?? []))].slice(
      0,
      MAX_SUMMARY_FACTS,
    );
    const labeled = await summarizeCommunity(
      memberNodes.map((n) => ({ name: n.name, kind: n.kind, naturalKey: n.natural_key })),
      facts,
      complete,
    );
    if (labeled.llm) usedLlm = true;
    communities.push({
      id: communityIdFor(memberIds, computedAt),
      name: labeled.name,
      summary: labeled.summary,
      nodeIds: memberIds,
      nodeCount: memberIds.length,
      algorithm: 'connected-components',
      computedAt,
    });
  }

  const prior = await exec.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM kg_communities WHERE invalidated_at IS NULL`,
  );
  await exec.query(`UPDATE kg_communities SET invalidated_at = $1::timestamptz WHERE invalidated_at IS NULL`, [
    computedAt,
  ]);

  for (const community of communities) {
    await exec.query(
      `INSERT INTO kg_communities (id, name, summary, node_ids, node_count, algorithm, computed_at, invalidated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        community.id,
        community.name,
        community.summary,
        JSON.stringify(community.nodeIds),
        community.nodeCount,
        community.algorithm,
        community.computedAt,
      ],
    );
  }

  return { communities, llm: usedLlm, invalidated: prior[0]?.n ?? 0 };
}

export async function graphCommunities(
  db: PGlite,
  params: Record<string, unknown>,
  deps: GraphCommunitiesDeps = {},
): Promise<GraphCommunitiesResult> {
  const limit =
    typeof params.limit === 'number' ? Math.min(Math.max(1, params.limit), MAX_COMMUNITIES) : 50;
  const refresh = params.refresh === true;
  const existing = await listCommunities(db, limit);
  if (!refresh && existing.length > 0) {
    return { communities: existing, computed: false, llm: false, invalidated: 0 };
  }
  const computed = await computeCommunities(db, deps);
  return {
    communities: computed.communities.slice(0, limit),
    computed: true,
    llm: computed.llm,
    invalidated: computed.invalidated,
  };
}
