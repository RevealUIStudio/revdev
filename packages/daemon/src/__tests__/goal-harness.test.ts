/**
 * GoalHarness + migration 0013 — create/list/activate/progress/propose-task.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { GoalHarness, GoalStore } from '../goals/index.js';
import { MIGRATIONS } from '../migrations/index.js';
import { migrate } from '../storage/migrate.js';

const DB_TEST_TIMEOUT = 60_000;

describe('GoalHarness (PR0)', () => {
  let db: PGlite;

  afterEach(async () => {
    await db?.close().catch(() => {});
  });

  it(
    'migrates goals tables and round-trips create → activate → progress → propose-task',
    async () => {
      db = new PGlite();
      const mig = await migrate(db, [...MIGRATIONS]);
      expect(mig.applied).toContain(13);

      const goalsTable = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'goals'`,
      );
      expect(goalsTable.rows[0]?.n).toBe(1);

      const harness = new GoalHarness({
        store: new GoalStore(db),
        agentId: 'test-agent',
      });

      const created = await harness.createGoal({
        id: 'gap-318-spine',
        title: 'Ship goal spine PR0',
        description: 'daemon goals tables + RPC',
        priority: 'high',
        criteria: ['schema migrates', 'createGoal round-trips'],
      });
      expect(created.goal.id).toBe('gap-318-spine');
      expect(created.goal.status).toBe('open');
      expect(created.criteria).toHaveLength(2);

      const listed = await harness.listGoals({ status: 'open' });
      expect(listed.some((g) => g.id === 'gap-318-spine')).toBe(true);

      const activated = await harness.activateGoal('gap-318-spine');
      expect(activated.success).toBe(true);
      expect(activated.goal?.status).toBe('active');

      const progress = await harness.progress('gap-318-spine');
      expect(progress?.percent).toBe(0);
      expect(progress?.readyToComplete).toBe(false);
      expect(progress?.criteria.pending).toBe(2);

      const actions = await harness.nextActions('gap-318-spine');
      expect(actions.every((a) => a.action === 'propose-task')).toBe(true);

      const firstCrit = created.criteria[0];
      if (!firstCrit) throw new Error('missing criterion');
      const proposed = await harness.proposeTaskForCriterion(firstCrit.id);
      expect(proposed.success).toBe(true);
      expect(proposed.created).toBe(true);
      expect(proposed.task?.status).toBe('open');

      // idempotent propose
      const again = await harness.proposeTaskForCriterion(firstCrit.id);
      expect(again.success).toBe(true);
      expect(again.created).toBe(false);
      expect(again.task?.id).toBe(proposed.task?.id);

      // complete refuses without criteria met
      const blocked = await harness.completeGoal('gap-318-spine');
      expect(blocked.success).toBe(false);

      // met requires evidence
      const noEvidence = await harness.recordCriterion(firstCrit.id, 'met', '');
      expect(noEvidence.success).toBe(false);

      // mark tasks completed + criteria met → complete
      await db.query(`UPDATE tasks SET status = 'completed', completed_at = NOW() WHERE id = $1`, [
        proposed.task?.id,
      ]);
      await harness.recordCriterion(firstCrit.id, 'met', 'schema smoke green');
      const second = created.criteria[1];
      if (!second) throw new Error('missing second criterion');
      const prop2 = await harness.proposeTaskForCriterion(second.id);
      await db.query(`UPDATE tasks SET status = 'completed', completed_at = NOW() WHERE id = $1`, [
        prop2.task?.id,
      ]);
      await harness.recordCriterion(second.id, 'met', 'round-trip green');

      const done = await harness.completeGoal('gap-318-spine');
      expect(done.success).toBe(true);
      expect(done.goal?.status).toBe('done');

      const finalProgress = await harness.progress('gap-318-spine');
      expect(finalProgress?.percent).toBe(100);
      expect(finalProgress?.readyToComplete).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'activate refuses unresolved blocked_by',
    async () => {
      db = new PGlite();
      await migrate(db, [...MIGRATIONS]);
      const harness = new GoalHarness({ store: new GoalStore(db), agentId: 'a' });
      await harness.createGoal({ id: 'blocker-g', title: 'Blocker', criteria: ['x'] });
      await harness.createGoal({
        id: 'child-g',
        title: 'Child',
        blockedBy: ['blocker-g'],
        criteria: ['y'],
      });
      const r = await harness.activateGoal('child-g');
      expect(r.success).toBe(false);
      expect(r.unresolvedBlockers).toContain('blocker-g');
    },
    DB_TEST_TIMEOUT,
  );
});
