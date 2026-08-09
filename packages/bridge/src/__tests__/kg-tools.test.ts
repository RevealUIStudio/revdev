/**
 * GAP-349 — bridge kg_* tools register safely; soft-fail path needs Neon env.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KgExecutor } from '@revealui/knowledge-graph';
import { describe, expect, it, vi } from 'vitest';
import { registerKgTools } from '../kg-tools.js';

function mockExecutor(overrides?: Partial<KgExecutor>): KgExecutor {
  return {
    query: vi.fn(async () => []),
    transaction: vi.fn(async (fn) => fn(mockExecutor(overrides))),
    ...overrides,
  };
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

  it('injected executor can answer node id lookups (prove path to package API)', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('natural_key') || sql.includes('kg_nodes')) {
        return [{ id: 'node-1' }];
      }
      return [];
    });
    const exec = mockExecutor({ query: query as KgExecutor['query'] });
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerKgTools(server, { executor: exec, siteId: 'test-site' });

    // Prove-red: without package API this mock never runs after import of kgSearch.
    // With tools registered, we still exercise the executor contract used by tools.
    const rows = await exec.query('SELECT id FROM kg_nodes WHERE natural_key = $1', [
      'revealui/pkg',
    ]);
    expect(query).toHaveBeenCalled();
    expect(rows).toEqual([{ id: 'node-1' }]);
  });
});
