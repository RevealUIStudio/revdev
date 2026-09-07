/**
 * Fleet knowledge graph tools on the revdev MCP bridge.
 *
 * Consumes published `@revealui/knowledge-graph/memory` helpers and
 * `assembleContext`. Daemon `memory.*` / `context.snapshot` stay on PGlite.
 * When the DB is unavailable, tools return a structured envelope and the rest
 * of the bridge (session/mail/daemon RPC) keeps working.
 *
 * Env (same resolve surface as revkg / daemon Neon):
 *   POSTGRES_URL | DATABASE_URL | POSTGRES_URL_FILE
 * Stream-safe: inject via revvault run, never print the URL.
 */

import { hostname } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  assembleContext,
  EDGE_RELATIONS,
  type EdgeInput,
  type EdgeRelation,
  type Embedder,
  type KgExecutor,
  kgAtTime,
  kgNeighbors,
  kgPath,
  makePoolExecutor,
  NODE_KINDS,
  type NodeInput,
  type NodeKind,
} from '@revealui/knowledge-graph';
import { resolveNaturalKey } from '@revealui/knowledge-graph/ingest';
import {
  type MemoryPrincipal,
  type MemoryResult,
  publishMemory,
  queryMemory,
  STUDIO_LOCAL_TENANT,
} from '@revealui/knowledge-graph/memory';
import { z } from 'zod';
import { loadStudioPrincipal, warnMissingPrincipal } from './kg-principal.js';

const PRODUCT_EPISODE_TYPES = ['agent-fact', 'memory', 'manual'] as const;

const DEFAULT_CONTEXT_CHAR_BUDGET = 16_000;
const DEFAULT_KG_TOOL_TIMEOUT_MS = 4000;

const NODE_KIND_TUPLE = NODE_KINDS as unknown as [string, ...string[]];
const EDGE_RELATION_TUPLE = EDGE_RELATIONS as unknown as [string, ...string[]];
const PRODUCT_EPISODE_TUPLE = PRODUCT_EPISODE_TYPES as unknown as [string, ...string[]];

export interface RegisterKgToolsOptions {
  /** Injected executor (tests). Production omits and resolves from @revealui/db/pool. */
  executor?: KgExecutor;
  /** Injected embedder (tests). Production resolves @revealui/ai/embeddings best-effort. */
  embedder?: Embedder;
  /** siteId on kg_add_episode; defaults to hostname(). */
  siteId?: string;
  /** Tests inject identity. Production loads hook-identity + REVDEV_AGENT_ID. */
  principalProvider?: () => MemoryPrincipal | null;
  /** Dispatch Promise.race budget in ms. Default 4000. `0` disables the race. */
  timeoutMs?: number;
}

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorContent(
  message: string,
  extra?: Record<string, unknown>,
): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'unavailable',
          available: false,
          ...extra,
          message,
        }),
      },
    ],
    isError: true,
  };
}

function wrapMemoryResult<T>(result: MemoryResult<T>): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
} {
  const body = jsonContent(result);
  if (result.status === 'unavailable') {
    return { ...body, isError: true };
  }
  return body;
}

function wrapOk(principal: MemoryPrincipal, data: unknown, deniedCount = 0) {
  return jsonContent({
    status: 'ok',
    available: true,
    enforcement: principal.trustBoundary === 'hosted' ? 'enforced' : 'deferred',
    deniedCount,
    data,
  });
}

async function raceTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  if (timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveProductionExecutor(): Promise<KgExecutor> {
  const { createPool, getConnectionIdentity } = await import('@revealui/db/pool');
  getConnectionIdentity();
  const pool = createPool({
    connectionTimeoutMillis: 30_000,
    queryTimeoutMillis: 60_000,
    statementTimeoutMillis: 60_000,
    max: 4,
  });
  return makePoolExecutor(pool);
}

/**
 * Register the seven kg_* tools on an McpServer instance.
 */
export function registerKgTools(server: McpServer, options?: RegisterKgToolsOptions): void {
  const defaultSiteId = options?.siteId ?? hostname();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_KG_TOOL_TIMEOUT_MS;
  const principalProvider = options?.principalProvider ?? loadStudioPrincipal;

  let cachedExecutor: KgExecutor | undefined = options?.executor;
  async function getExecutor(): Promise<KgExecutor> {
    if (cachedExecutor) return cachedExecutor;
    cachedExecutor = await resolveProductionExecutor();
    return cachedExecutor;
  }

  let cachedEmbedder: Embedder | null | undefined = options?.embedder;
  async function resolveEmbedder(): Promise<Embedder | undefined> {
    if (cachedEmbedder !== undefined) return cachedEmbedder ?? undefined;
    try {
      const specifier = '@revealui/ai/embeddings';
      const ai = (await import(specifier)) as {
        generateEmbedding(text: string): Promise<{ vector: number[] }>;
      };
      cachedEmbedder = async (text: string): Promise<number[]> => {
        const result = await ai.generateEmbedding(text);
        return result.vector;
      };
    } catch {
      cachedEmbedder = null;
    }
    return cachedEmbedder ?? undefined;
  }

  function requirePrincipal(): MemoryPrincipal | ReturnType<typeof errorContent> {
    const principal = principalProvider();
    if (!principal) {
      warnMissingPrincipal();
      return errorContent('principal is required', { reason: 'principal-missing' });
    }
    return principal;
  }

  async function withExecutor<T>(
    fn: (exec: KgExecutor, principal: MemoryPrincipal) => Promise<T>,
  ): Promise<T | ReturnType<typeof errorContent>> {
    const principal = requirePrincipal();
    if ('isError' in principal) return principal;
    try {
      const exec = await getExecutor();
      return await raceTimeout(
        fn(exec, principal),
        timeoutMs,
        () => errorContent('knowledge graph tool timed out', { reason: 'timeout' }) as unknown as T,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorContent(
        `knowledge graph database unavailable (set POSTGRES_URL / DATABASE_URL / POSTGRES_URL_FILE via revvault): ${msg}`,
        { reason: 'kg-database-unavailable' },
      );
    }
  }

  server.tool(
    'kg_search',
    'Hybrid search over the fleet knowledge graph (vector + FTS + BFS, RRF-fused). Prefer kg_context when you have a natural-key anchor.',
    {
      query: z.string().min(1).describe('Free-text query'),
      anchor: z.string().min(1).optional().describe('Anchor node id for BFS channel'),
      kinds: z.array(z.enum(NODE_KIND_TUPLE)).optional(),
      relations: z.array(z.enum(EDGE_RELATION_TUPLE)).optional(),
      at: z.string().optional().describe('ISO-8601 point-in-time; omit for current graph'),
      limit: z.number().int().positive().max(100).optional(),
      bfsDepth: z.number().int().min(1).max(6).optional(),
    },
    async (args) => {
      const out = await withExecutor(async (exec, principal) => {
        return queryMemory(exec, {
          principal,
          query: args.query,
          kinds: args.kinds as NodeKind[] | undefined,
          relations: args.relations as EdgeRelation[] | undefined,
          at: args.at ? new Date(args.at) : undefined,
          limit: args.limit,
        });
      });
      if (out && typeof out === 'object' && 'isError' in out) return out;
      return wrapMemoryResult(out);
    },
  );

  server.tool(
    'kg_get_node',
    'Fetch a node and its current facts by natural key',
    {
      naturalKey: z
        .string()
        .min(1)
        .describe('e.g. revealui/packages/ai/src/llm/client.ts#getClient'),
    },
    async ({ naturalKey }) => {
      const out = await withExecutor(async (exec, principal) => {
        const id = await resolveNaturalKey(exec, naturalKey);
        if (!id) throw new Error(`no node with natural key: ${naturalKey}`);
        const rows = await exec.query<{
          id: string;
          kind: string;
          name: string;
          natural_key: string;
          repo: string | null;
          summary: string | null;
        }>(
          `SELECT id, kind, name, natural_key, repo, summary, attributes, first_seen_at, last_confirmed_at
           FROM kg_nodes WHERE id = $1`,
          [id],
        );
        const node = rows[0];
        if (!node) throw new Error(`node ${id} vanished`);
        const facts = await kgAtTime(exec, id, new Date());
        return wrapOk(principal, { node, facts });
      });
      if (out && typeof out === 'object' && 'isError' in out) return out;
      return out;
    },
  );

  server.tool(
    'kg_neighbors',
    'BFS neighbors of a node (current graph, or as of a point-in-time)',
    {
      naturalKey: z.string().min(1),
      depth: z.number().int().min(1).max(6).optional().describe('Max hops (default 1)'),
      relations: z.array(z.enum(EDGE_RELATION_TUPLE)).optional(),
      at: z.string().optional(),
    },
    async ({ naturalKey, depth, relations, at }) => {
      const out = await withExecutor(async (exec, principal) => {
        const id = await resolveNaturalKey(exec, naturalKey);
        if (!id) throw new Error(`no node with natural key: ${naturalKey}`);
        const data = await kgNeighbors(exec, id, {
          depth: depth ?? 1,
          relations: relations as EdgeRelation[] | undefined,
          at: at ? new Date(at) : undefined,
        });
        return wrapOk(principal, data);
      });
      if (out && typeof out === 'object' && 'isError' in out) return out;
      return out;
    },
  );

  server.tool(
    'kg_add_episode',
    'Publish an agent-fact / memory / manual episode. ONLY write tool — always additive (never a rescan).',
    {
      episodeType: z.enum(PRODUCT_EPISODE_TUPLE),
      source: z.string().min(1).describe('e.g. grok-session, shared_facts:…'),
      content: z.string().min(1).describe('Durable finding summary'),
      contentRef: z.record(z.string(), z.unknown()).optional(),
      referenceTime: z.string().optional().describe('ISO-8601; defaults to now'),
      siteId: z.string().optional(),
      nodes: z
        .array(
          z.object({
            kind: z.enum(NODE_KIND_TUPLE),
            name: z.string(),
            naturalKey: z.string(),
            repo: z.string().optional(),
            summary: z.string().optional(),
            attributes: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
      edges: z
        .array(
          z.object({
            source: z.object({ kind: z.enum(NODE_KIND_TUPLE), naturalKey: z.string() }),
            target: z.object({ kind: z.enum(NODE_KIND_TUPLE), naturalKey: z.string() }),
            relation: z.enum(EDGE_RELATION_TUPLE),
            fact: z.string(),
            repo: z.string().optional(),
            validAt: z.string().optional(),
            attributes: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
    },
    async (args) => {
      void args.source;
      const out = await withExecutor(async (exec, principal) => {
        const nodes: NodeInput[] = (args.nodes ?? []).map((n) => ({
          kind: n.kind as NodeKind,
          name: n.name,
          naturalKey: n.naturalKey,
          repo: n.repo,
          summary: n.summary,
          attributes: n.attributes,
        }));
        const extraEdges: EdgeInput[] = (args.edges ?? []).map((e) => ({
          source: {
            kind: e.source.kind as NodeKind,
            naturalKey: e.source.naturalKey,
          },
          target: {
            kind: e.target.kind as NodeKind,
            naturalKey: e.target.naturalKey,
          },
          relation: e.relation as EdgeRelation,
          fact: e.fact,
          repo: e.repo,
          validAt: e.validAt ? new Date(e.validAt) : undefined,
          attributes: e.attributes,
        }));
        const embedder = await resolveEmbedder();
        return publishMemory(
          exec,
          {
            principal,
            scope: {
              tenantId: principal.tenantId || STUDIO_LOCAL_TENANT,
              workspaceId: principal.workspaceId,
              classification: 'workspace',
            },
            episodeType: args.episodeType as (typeof PRODUCT_EPISODE_TYPES)[number],
            summary: args.content,
            subjects: nodes,
            extraEdges,
            referenceTime: args.referenceTime ? new Date(args.referenceTime) : new Date(),
            siteId: args.siteId ?? defaultSiteId,
          },
          { embedder, recordOutbox: true },
        );
      });
      if (out && typeof out === 'object' && 'isError' in out) return out;
      return wrapMemoryResult(out);
    },
  );

  server.tool(
    'kg_path',
    'Shortest path (node list) between two nodes by natural key',
    {
      fromNaturalKey: z.string().min(1),
      toNaturalKey: z.string().min(1),
      at: z.string().optional(),
      maxDepth: z.number().int().min(1).max(12).optional(),
    },
    async ({ fromNaturalKey, toNaturalKey, at, maxDepth }) => {
      const out = await withExecutor(async (exec, principal) => {
        const fromId = await resolveNaturalKey(exec, fromNaturalKey);
        const toId = await resolveNaturalKey(exec, toNaturalKey);
        if (!fromId) throw new Error(`no node with natural key: ${fromNaturalKey}`);
        if (!toId) throw new Error(`no node with natural key: ${toNaturalKey}`);
        const data = await kgPath(exec, fromId, toId, {
          at: at ? new Date(at) : undefined,
          maxDepth: maxDepth ?? 6,
        });
        return wrapOk(principal, data);
      });
      if (out && typeof out === 'object' && 'isError' in out) return out;
      return out;
    },
  );

  server.tool(
    'kg_at_time',
    "A node's facts as of a point-in-time timestamp",
    {
      naturalKey: z.string().min(1),
      at: z.string().describe('ISO-8601 timestamp'),
    },
    async ({ naturalKey, at }) => {
      const out = await withExecutor(async (exec, principal) => {
        const id = await resolveNaturalKey(exec, naturalKey);
        if (!id) throw new Error(`no node with natural key: ${naturalKey}`);
        const data = await kgAtTime(exec, id, new Date(at));
        return wrapOk(principal, data);
      });
      if (out && typeof out === 'object' && 'isError' in out) return out;
      return out;
    },
  );

  server.tool(
    'kg_context',
    'Budgeted context assembly from an anchor natural key (prefer over kg_search when you know the subject)',
    {
      naturalKey: z.string().min(1),
      charBudget: z.number().int().positive().max(200_000).optional(),
      depth: z.number().int().min(1).max(6).optional(),
      at: z.string().optional(),
    },
    async ({ naturalKey, charBudget, depth, at }) => {
      const budget = charBudget ?? DEFAULT_CONTEXT_CHAR_BUDGET;
      const bfsDepth = depth ?? 3;
      const out = await withExecutor(async (exec, principal) => {
        const id = await resolveNaturalKey(exec, naturalKey);
        if (!id) throw new Error(`no node with natural key: ${naturalKey}`);
        const assembled = await assembleContext(exec, id, {
          charBudget: budget,
          depth: bfsDepth,
          at: at ? new Date(at) : undefined,
          principal,
        });
        return wrapOk(principal, assembled);
      });
      if (out && typeof out === 'object' && 'isError' in out) return out;
      return out;
    },
  );
}
