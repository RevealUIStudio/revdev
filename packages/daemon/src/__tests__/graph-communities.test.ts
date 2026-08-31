/**
 * GAP-349 P5 leftover — kg_communities clustering + LLM summaries.
 *
 * Connected components are deterministic. Summaries use an injected completer
 * (`@revealui/ai` in production). Refresh invalidates prior rows; never deletes.
 */

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  communityIdFor,
  connectedComponents,
  graphCommunities,
} from '../graph-communities.js';
import { graphAddEpisode } from '../graph.js';
import { migrate } from '../storage/migrate.js';

const DB_TEST_TIMEOUT = 60_000;

async function boot(): Promise<PGlite> {
  const db = new PGlite();
  await migrate(db);
  return db;
}

describe('connectedComponents', () => {
  it('groups an edge pair and leaves an isolated node alone', () => {
    const groups = connectedComponents(
      ['a', 'b', 'c'],
      [
        { sourceId: 'a', targetId: 'b' },
        { sourceId: 'b', targetId: 'a' },
      ],
    );
    expect(groups[0]).toEqual(['a', 'b']);
    expect(groups[1]).toEqual(['c']);
  });

  it('community ids are stable for the same member set', () => {
    expect(communityIdFor(['n1', 'n2'])).toBe(communityIdFor(['n1', 'n2']));
    expect(communityIdFor(['n1', 'n2'])).not.toBe(communityIdFor(['n1']));
    expect(communityIdFor(['n1'], '2026-08-31T00:00:00.000Z')).not.toBe(communityIdFor(['n1']));
  });
});

describe('kg_communities (GAP-349 P5 leftover)', () => {
  let db: PGlite;

  afterEach(async () => {
    await db?.close().catch(() => {});
  });

  it(
    'clusters connected nodes, writes LLM summaries, and invalidates on refresh',
    async () => {
      db = await boot();
      await graphAddEpisode(
        db,
        {
          episodeType: 'agent-fact',
          source: 'test',
          content: 'proxy retries on 5xx',
          nodes: [
            {
              kind: 'file',
              name: 'electric-proxy.ts',
              naturalKey: 'revealui/apps/admin/src/lib/api/electric-proxy.ts',
              repo: 'revealui',
            },
            {
              kind: 'concept',
              name: 'Electric proxy retry',
              naturalKey: 'concept:electric-proxy-retry',
            },
            {
              kind: 'concept',
              name: 'Unrelated isolated',
              naturalKey: 'concept:isolated',
            },
          ],
          edges: [
            {
              source: { kind: 'concept', naturalKey: 'concept:electric-proxy-retry' },
              target: {
                kind: 'file',
                naturalKey: 'revealui/apps/admin/src/lib/api/electric-proxy.ts',
              },
              relation: 'documents',
              fact: 'electric-proxy.ts retries with exponential backoff on 5xx',
            },
          ],
        },
        'test-site',
      );

      const first = await graphCommunities(
        db,
        { refresh: true },
        {
          complete: async () =>
            JSON.stringify({ name: 'Electric proxy', summary: 'Retry policy for the Electric proxy.' }),
        },
      );
      expect(first.computed).toBe(true);
      expect(first.llm).toBe(true);
      expect(first.communities.length).toBeGreaterThanOrEqual(2);
      const named = first.communities.find((c) => c.name === 'Electric proxy');
      expect(named?.summary).toContain('Retry policy');
      expect(named?.nodeCount).toBeGreaterThanOrEqual(2);

      const cached = await graphCommunities(db, {});
      expect(cached.computed).toBe(false);
      expect(cached.communities.map((c) => c.id).sort()).toEqual(
        first.communities.map((c) => c.id).sort(),
      );

      const refreshed = await graphCommunities(
        db,
        { refresh: true },
        { complete: async () => JSON.stringify({ name: 'Proxy cluster', summary: 'Second pass.' }) },
      );
      expect(refreshed.computed).toBe(true);
      expect(refreshed.invalidated).toBeGreaterThan(0);

      const current = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM kg_communities WHERE invalidated_at IS NULL`,
      );
      const all = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM kg_communities`);
      expect(current.rows[0]?.n).toBe(refreshed.communities.length);
      expect(all.rows[0]?.n).toBeGreaterThan(current.rows[0]?.n ?? 0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'falls back to a template summary when the completer fails',
    async () => {
      db = await boot();
      await graphAddEpisode(
        db,
        {
          episodeType: 'manual',
          source: 'test',
          content: 'solo node',
          nodes: [{ kind: 'concept', name: 'Solo', naturalKey: 'concept:solo' }],
        },
        'test-site',
      );
      const result = await graphCommunities(
        db,
        { refresh: true },
        { complete: async () => 'not-json' },
      );
      expect(result.computed).toBe(true);
      expect(result.llm).toBe(false);
      expect(result.communities[0]?.name).toContain('Solo');
    },
    DB_TEST_TIMEOUT,
  );
});
