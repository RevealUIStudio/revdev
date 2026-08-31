/**
 * GAP-349 P5 leftover — Layer-3 shared_facts → kg episodes.
 *
 * Injected fact source (no hub). Heuristic reconcile is the production path.
 * Superseded facts invalidate edges; rows are never deleted. Re-runs skip
 * already-ingested sources.
 */

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { graphAddEpisode } from '../graph.js';
import {
  graphReconcile,
  invalidateEdgesForEpisodeSource,
  reconcileHeuristicLocal,
  type SharedFactRow,
} from '../graph-reconcile.js';
import { migrate } from '../storage/migrate.js';

const DB_TEST_TIMEOUT = 60_000;

async function boot(): Promise<PGlite> {
  const db = new PGlite();
  await migrate(db);
  return db;
}

const FACT_A: SharedFactRow = {
  id: 'fact-a',
  agentId: 'agent-1',
  content: 'electric proxy retries on 5xx',
  factType: 'discovery',
  confidence: 0.9,
  tags: ['kg'],
  createdAt: '2026-08-30T00:00:00.000Z',
  sessionId: 'sess-1',
};

const FACT_A_DUP: SharedFactRow = {
  id: 'fact-a-dup',
  agentId: 'agent-2',
  content: 'Electric proxy retries on 5xx',
  factType: 'discovery',
  confidence: 0.8,
  tags: ['kg'],
  createdAt: '2026-08-30T00:01:00.000Z',
  sessionId: 'sess-1',
};

describe('reconcileHeuristicLocal', () => {
  it('collapses case-insensitive duplicate content', () => {
    const result = reconcileHeuristicLocal([FACT_A, FACT_A_DUP]);
    expect(result.canonicalFacts).toHaveLength(1);
    expect(result.duplicates).toEqual([['fact-a', 'fact-a-dup']]);
    expect(result.canonicalFacts[0]?.sourceFactIds).toEqual(['fact-a', 'fact-a-dup']);
  });
});

describe('Layer-3 shared_facts reconcile (GAP-349 P5 leftover)', () => {
  let db: PGlite;

  afterEach(async () => {
    await db?.close().catch(() => {});
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
  });

  it(
    'no-ops without a hub or injected source instead of inventing a store',
    async () => {
      db = await boot();
      const result = await graphReconcile(db, {});
      expect(result.hub).toBe(false);
      expect(result.ingested).toBe(0);
      expect(result.reason).toMatch(/no POSTGRES_URL/);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'ingests Layer-3 canonical facts as kg episodes and skips on re-run',
    async () => {
      db = await boot();
      const first = await graphReconcile(
        db,
        { sessionId: 'sess-1' },
        { fetchFacts: async () => [FACT_A, FACT_A_DUP] },
      );
      expect(first.hub).toBe(true);
      expect(first.fetched).toBe(2);
      expect(first.ingested).toBe(1);
      expect(first.skipped).toBe(0);

      const episodes = await db.query<{ source: string; content: string }>(
        `SELECT source, content FROM kg_episodes`,
      );
      expect(episodes.rows).toHaveLength(1);
      expect(episodes.rows[0]?.source).toBe('shared_facts:fact-a+fact-a-dup');
      expect(episodes.rows[0]?.content).toMatch(/electric proxy retries/i);

      const nodes = await db.query<{ natural_key: string }>(
        `SELECT natural_key FROM kg_nodes WHERE kind = 'concept'`,
      );
      expect(nodes.rows.some((n) => n.natural_key.startsWith('shared-fact:'))).toBe(true);

      const second = await graphReconcile(db, {}, { fetchFacts: async () => [FACT_A, FACT_A_DUP] });
      expect(second.ingested).toBe(0);
      expect(second.skipped).toBe(1);
      const again = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM kg_episodes`);
      expect(again.rows[0]?.n).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'invalidates edges for superseded facts and never deletes them',
    async () => {
      db = await boot();
      await graphAddEpisode(
        db,
        {
          episodeType: 'memory',
          source: 'shared_facts:old-fact',
          content: 'old claim',
          nodes: [
            { kind: 'concept', name: 'Old', naturalKey: 'concept:old-claim' },
            { kind: 'file', name: 'proxy.ts', naturalKey: 'repo/proxy.ts', repo: 'revdev' },
          ],
          edges: [
            {
              source: { kind: 'concept', naturalKey: 'concept:old-claim' },
              target: { kind: 'file', naturalKey: 'repo/proxy.ts' },
              relation: 'mentions',
              fact: 'old claim about proxy.ts',
            },
          ],
        },
        'test-site',
      );
      const before = await db.query<{ id: string; invalid_at: string | null }>(
        `SELECT id, invalid_at FROM kg_edges`,
      );
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]?.invalid_at).toBeNull();

      const invalidated = await invalidateEdgesForEpisodeSource(db, 'shared_facts:old-fact');
      expect(invalidated).toBe(1);
      const after = await db.query<{ id: string; invalid_at: string | null }>(
        `SELECT id, invalid_at FROM kg_edges`,
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]?.invalid_at).not.toBeNull();
      expect(after.rows[0]?.id).toBe(before.rows[0]?.id);

      const result = await graphReconcile(
        db,
        {},
        {
          fetchFacts: async () => [
            {
              id: 'old-fact',
              agentId: 'agent-1',
              content: 'old claim',
              factType: 'discovery',
              confidence: 0.4,
              tags: [],
              supersededBy: 'new-fact',
              createdAt: '2026-08-30T02:00:00.000Z',
            },
            {
              id: 'new-fact',
              agentId: 'agent-1',
              content: 'updated claim',
              factType: 'discovery',
              confidence: 0.95,
              tags: [],
              createdAt: '2026-08-30T02:01:00.000Z',
            },
          ],
        },
      );
      expect(result.invalidatedEdges).toBe(0);
      expect(result.ingested).toBe(1);
      const edgesStill = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM kg_edges`);
      expect(edgesStill.rows[0]?.n).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );
});
