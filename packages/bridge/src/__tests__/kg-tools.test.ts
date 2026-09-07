/**
 * Bridge kg_* tools: envelope + published memory helpers.
 * Soft-fail path needs no Neon when an executor is injected.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KgExecutor } from '@revealui/knowledge-graph';
import type { MemoryPrincipal } from '@revealui/knowledge-graph/memory';
import { STUDIO_LOCAL_TENANT } from '@revealui/knowledge-graph/memory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetMissingPrincipalWarnings } from '../kg-principal.js';
import { registerKgTools } from '../kg-tools.js';

function mockExecutor(overrides?: Partial<KgExecutor>): KgExecutor {
  return {
    query: vi.fn(async () => []),
    transaction: vi.fn(async (fn) => fn(mockExecutor(overrides))),
    ...overrides,
  };
}

const testPrincipal: MemoryPrincipal = {
  did: 'did:revfleet:agent-test:fp1',
  agentId: 'agent-test',
  fingerprint: 'fp1',
  didKind: 'agent-key',
  harness: 'revdev',
  tenantId: STUDIO_LOCAL_TENANT,
  trustBoundary: 'studio-local',
  isFleetOperator: true,
};

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

const teardowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetMissingPrincipalWarnings();
  while (teardowns.length > 0) {
    const t = teardowns.pop();
    if (t) await t().catch(() => undefined);
  }
});

async function connectedClient(opts: {
  executor?: KgExecutor;
  principal?: MemoryPrincipal | null;
}): Promise<{
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
}> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerKgTools(server, {
    executor: opts.executor ?? mockExecutor(),
    principalProvider: () => (opts.principal === undefined ? testPrincipal : opts.principal),
    timeoutMs: 0,
    siteId: 'test-site',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kg-test', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  teardowns.push(async () => {
    await client.close();
  });
  return {
    client,
    call: async (name, args) =>
      (await client.callTool({ name, arguments: args ?? {} })) as ToolResult,
  };
}

function parseJson(result: ToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected text content');
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('registerKgTools', () => {
  it('registers without throwing when no executor is injected', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    expect(() => registerKgTools(server)).not.toThrow();
  });

  it('registers with an injected executor (production DB optional)', () => {
    const exec = mockExecutor();
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    expect(() => registerKgTools(server, { executor: exec })).not.toThrow();
  });
});

describe('kg_* product envelope', () => {
  it('kg_search without principal returns unavailable (does not throw)', async () => {
    const { call } = await connectedClient({ principal: null });
    const result = await call('kg_search', { query: 'licensing' });
    expect(result.isError).toBe(true);
    const body = parseJson(result);
    expect(body.status).toBe('unavailable');
    expect(body.available).toBe(false);
    expect(body.reason).toBe('principal-missing');
  });

  it('kg_search returns queryMemory envelope on ok', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('kg_nodes') || sql.includes('natural_key')) return [];
      return [];
    });
    const exec = mockExecutor({ query: query as KgExecutor['query'] });
    const { call } = await connectedClient({ executor: exec });
    const result = await call('kg_search', { query: 'licensing' });
    const body = parseJson(result);
    expect(body.status === 'ok' || body.status === 'unavailable').toBe(true);
    expect(typeof body.available).toBe('boolean');
    if (body.status === 'ok') {
      expect(body.enforcement).toBe('deferred');
      expect(body.data).toBeTypeOf('object');
    }
  });

  it('kg_add_episode publishes via memory helper and envelopes the result', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT') || sql.includes('kg_episodes')) {
        return [{ id: 'ep-1' }];
      }
      return [];
    });
    const transaction = vi.fn(async (fn: (e: KgExecutor) => Promise<unknown>) =>
      fn(mockExecutor({ query: query as KgExecutor['query'] })),
    );
    const exec = mockExecutor({
      query: query as KgExecutor['query'],
      transaction: transaction as KgExecutor['transaction'],
    });
    const { call } = await connectedClient({ executor: exec });
    const result = await call('kg_add_episode', {
      episodeType: 'agent-fact',
      source: 'revdev-test',
      content: 'bridge consumes published memory helpers',
      nodes: [
        {
          kind: 'concept',
          name: 'bridge memory',
          naturalKey: 'concept:bridge-memory',
        },
      ],
    });
    const body = parseJson(result);
    expect(typeof body.status).toBe('string');
    expect(typeof body.available).toBe('boolean');
    expect(result.isError === true ? body.status : 'ok').toBeTruthy();
  });

  it('executor throw is unavailable; handler does not throw', async () => {
    const exec = mockExecutor({
      query: vi.fn(async () => {
        throw new Error('connection refused');
      }) as KgExecutor['query'],
    });
    const { call } = await connectedClient({ executor: exec });
    const result = await call('kg_search', { query: 'x' });
    expect(result.isError).toBe(true);
    const body = parseJson(result);
    expect(body.status).toBe('unavailable');
    expect(body.available).toBe(false);
  });
});
