/**
 * GAP-349 P5b — Electric down-sync + hub anti-entropy.
 *
 * Delete ops from Electric are skipped (invalidate-not-delete). Hub snapshot
 * merges invalid_at with LEAST. No Electric/hub → no-op, does not invent a store.
 */

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { graphStatus } from '../graph.js';
import { applyHubRow, ensureGraphSiteId, graphSyncPull, type ShapePage } from '../graph-sync.js';
import { migrate } from '../storage/migrate.js';

const DB_TEST_TIMEOUT = 60_000;

async function boot(): Promise<PGlite> {
  const db = new PGlite();
  await migrate(db);
  return db;
}

const NODE = {
  id: 'node-file-1',
  kind: 'file',
  name: 'graph-sync.ts',
  natural_key: 'revdev/packages/daemon/src/graph-sync.ts',
  repo: 'revdev',
  summary: 'Electric down-sync',
  search_text: 'graph-sync electric down-sync',
  attributes: {},
  first_seen_at: '2026-08-19T00:00:00.000Z',
  last_confirmed_at: '2026-08-19T00:00:00.000Z',
};

const EDGE = {
  id: 'edge-1',
  source_id: 'node-file-1',
  target_id: 'node-file-1',
  relation: 'mentions',
  fact: 'graph-sync.ts implements Electric down-sync',
  repo: 'revdev',
  attributes: {},
  valid_at: '2026-08-19T00:00:00.000Z',
  invalid_at: null as string | null,
  expired_at: null as string | null,
};

describe('knowledge-graph down-sync (GAP-349 P5b)', () => {
  let db: PGlite;

  afterEach(async () => {
    await db?.close().catch(() => {});
    delete process.env.ELECTRIC_SERVICE_URL;
    delete process.env.ELECTRIC_SECRET;
    delete process.env.REVDEV_KG_SITE_ID;
    delete process.env.REVDEV_KG_REPOS;
  });

  it(
    'persists siteId on graph_site and returns the same id on later status',
    async () => {
      process.env.REVDEV_KG_SITE_ID = 'daemon:p5b-test';
      db = await boot();
      const first = await ensureGraphSiteId(db);
      expect(first).toBe('daemon:p5b-test');
      delete process.env.REVDEV_KG_SITE_ID;
      const second = await ensureGraphSiteId(db, 'daemon:should-not-win');
      expect(second).toBe('daemon:p5b-test');
      const status = await graphStatus(db);
      expect(status.siteId).toBe('daemon:p5b-test');
      expect(status.electricConfigured).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'no-ops without Electric or hub instead of inventing a second store',
    async () => {
      db = await boot();
      const result = await graphSyncPull(db, { repos: ['revdev'] });
      expect(result.applied).toBe(0);
      expect(result.electricConfigured).toBe(false);
      expect(result.hubConfigured).toBe(false);
      expect(result.reason).toMatch(/no ELECTRIC_SERVICE_URL/);
      const status = await graphStatus(db);
      expect(status.nodes).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'applies Electric insert/update and skips delete',
    async () => {
      process.env.ELECTRIC_SERVICE_URL = 'http://electric.test';
      db = await boot();
      const pages: ShapePage[] = [
        {
          messages: [
            { headers: { operation: 'insert' }, value: NODE },
            { headers: { operation: 'insert' }, value: EDGE },
            { headers: { operation: 'delete' }, value: { id: 'node-file-1' } },
            { headers: { control: 'up-to-date' } },
          ],
          offset: '0_0',
          handle: 'h1',
          upToDate: true,
        },
      ];
      const result = await graphSyncPull(
        db,
        { repos: ['revdev'] },
        {
          fetchShapePage: async (url) => {
            expect(
              url.searchParams.get('table') === 'kg_nodes' ||
                url.searchParams.get('table') === 'kg_edges',
            ).toBe(true);
            expect(url.searchParams.get('where')).toContain('revdev');
            return pages[0] ?? { messages: [], upToDate: true };
          },
        },
      );
      expect(result.skippedDeletes).toBeGreaterThan(0);
      expect(result.applied).toBeGreaterThan(0);
      const status = await graphStatus(db);
      expect(status.nodes).toBe(1);
      expect(status.edges).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'hub snapshot merges invalid_at with LEAST (anti-entropy)',
    async () => {
      db = await boot();
      await applyHubRow(db, 'kg_nodes', NODE);
      await applyHubRow(db, 'kg_edges', EDGE);
      const invalidated = {
        ...EDGE,
        invalid_at: '2026-08-20T00:00:00.000Z',
      };
      const result = await graphSyncPull(
        db,
        { repos: ['revdev'] },
        {
          snapshotTable: async (table) => {
            if (table === 'kg_nodes') return [NODE];
            if (table === 'kg_edges') return [invalidated];
            return [];
          },
        },
      );
      expect(result.applied).toBeGreaterThan(0);
      const rows = await db.query<{ invalid_at: string | null }>(
        `SELECT invalid_at FROM kg_edges WHERE id = $1`,
        [EDGE.id],
      );
      expect(rows.rows[0]?.invalid_at).not.toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'refuses to pull when no repos are in scope',
    async () => {
      process.env.ELECTRIC_SERVICE_URL = 'http://electric.test';
      db = await boot();
      const result = await graphSyncPull(db, {});
      expect(result.applied).toBe(0);
      expect(result.reason).toMatch(/no repos/);
    },
    DB_TEST_TIMEOUT,
  );
});
