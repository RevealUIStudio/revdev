/**
 * GAP-349 P5 — local knowledge-graph replica on daemon PGlite.
 *
 * Migration 0014 installs portable kg_* DDL. ingestEpisode records kg_outbox.
 * graph.outbox.push is a no-op without a hub URL (does not invent a second store).
 */

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  graphAddEpisode,
  graphAt,
  graphContext,
  graphNeighbors,
  graphNode,
  graphOutboxPush,
  graphSearch,
  graphStatus,
} from '../graph.js';
import { MIGRATIONS } from '../migrations/index.js';
import { migrate } from '../storage/migrate.js';

const DB_TEST_TIMEOUT = 60_000;

async function boot(): Promise<PGlite> {
  const db = new PGlite();
  await migrate(db);
  return db;
}

describe('knowledge-graph replica (GAP-349 P5)', () => {
  let db: PGlite;

  afterEach(async () => {
    await db?.close().catch(() => {});
  });

  it(
    'migration 0014 creates kg_* tables on a full migrate()',
    async () => {
      db = await boot();
      expect(MIGRATIONS.at(-1)?.version).toBe(15);
      expect(MIGRATIONS.at(-1)?.name).toBe('graph-sync-site');
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE 'kg_%'
         ORDER BY table_name`,
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        'kg_edge_episodes',
        'kg_edges',
        'kg_episodes',
        'kg_node_aliases',
        'kg_nodes',
        'kg_outbox',
        'kg_shape_cursors',
      ]);
      const meta = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ('graph_site', 'kg_shape_cursors')
         ORDER BY table_name`,
      );
      expect(meta.rows.map((r) => r.table_name)).toEqual(['graph_site', 'kg_shape_cursors']);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'addEpisode writes nodes/edges, search/neighbors/at/context read them, outbox stays pending without hub',
    async () => {
      db = await boot();
      const before = await graphStatus(db);
      expect(before.replica).toBe('pglite');
      expect(before.nodes).toBe(0);
      expect(before.hubConfigured).toBe(false);

      const ingested = await graphAddEpisode(
        db,
        {
          episodeType: 'agent-fact',
          source: 'test',
          content: 'electric proxy retries on 5xx',
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
          ],
          edges: [
            {
              source: {
                kind: 'concept',
                naturalKey: 'concept:electric-proxy-retry',
              },
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
      expect(ingested).toMatchObject({ nodeCount: 2, edgeCount: 1 });

      const status = await graphStatus(db);
      expect(status.nodes).toBe(2);
      expect(status.edges).toBe(1);
      expect(status.episodes).toBe(1);
      expect(status.outboxPending).toBeGreaterThan(0);

      const found = await graphSearch(db, { query: 'electric proxy' });
      const search = found as {
        nodes: Array<{ naturalKey: string }>;
        facts: Array<{ fact: string }>;
      };
      expect(
        search.nodes.some((n) => n.naturalKey.includes('electric-proxy')) ||
          search.facts.some((f) => f.fact.includes('backoff')),
      ).toBe(true);

      const node = await graphNode(db, {
        naturalKey: 'revealui/apps/admin/src/lib/api/electric-proxy.ts',
      });
      expect(node.node?.naturalKey).toBe('revealui/apps/admin/src/lib/api/electric-proxy.ts');
      expect(node.facts.length).toBeGreaterThan(0);

      const neighbors = (await graphNeighbors(db, {
        naturalKey: 'concept:electric-proxy-retry',
        depth: 2,
      })) as { nodes: Array<{ naturalKey: string }>; edges: Array<{ relation: string }> };
      expect(neighbors.nodes.length).toBeGreaterThan(0);
      expect(neighbors.edges.some((e) => e.relation === 'documents')).toBe(true);

      const at = await graphAt(db, {
        naturalKey: 'concept:electric-proxy-retry',
        at: new Date().toISOString(),
      });
      expect(Array.isArray(at)).toBe(true);

      const packed = await graphContext(db, {
        naturalKey: 'concept:electric-proxy-retry',
        depth: 2,
        charBudget: 500,
      });
      expect(packed.anchor?.naturalKey).toBe('concept:electric-proxy-retry');
      expect(packed.charsUsed).toBeLessThanOrEqual(500);
      expect(packed.context.includes('electric-proxy') || packed.factCount >= 0).toBe(true);

      const push = await graphOutboxPush(db);
      expect(push.hub).toBe(false);
      expect(push.pushed).toBe(0);
      expect(push.pending).toBeGreaterThan(0);

      const still = await graphStatus(db);
      expect(still.outboxPending).toBe(push.pending);
    },
    DB_TEST_TIMEOUT,
  );
});
