/**
 * GoalStore — PGlite persistence for goals + criteria (+ thin task/event helpers).
 *
 * Direct SQL (same style as server.ts task handlers). No second daemon process.
 */

import type { PGlite } from '@electric-sql/pglite';
import type { GoalCriterionRow, GoalRow, GoalStatus, GoalTaskRow } from './types.js';

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      return [];
    }
  }
  return [];
}

function mapGoal(row: Record<string, unknown>): GoalRow {
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    status: row.status as GoalRow['status'],
    priority: row.priority as GoalRow['priority'],
    owner: row.owner as GoalRow['owner'],
    parent_goal_id: row.parent_goal_id == null ? null : String(row.parent_goal_id),
    blocked_by: asStringArray(row.blocked_by),
    created_by: String(row.created_by ?? ''),
    status_reason: String(row.status_reason ?? ''),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    closed_at: row.closed_at == null ? null : String(row.closed_at),
  };
}

function mapCriterion(row: Record<string, unknown>): GoalCriterionRow {
  return {
    id: String(row.id),
    goal_id: String(row.goal_id),
    description: String(row.description ?? ''),
    status: row.status as GoalCriterionRow['status'],
    evidence: String(row.evidence ?? ''),
    verified_by: row.verified_by == null ? null : String(row.verified_by),
    verified_at: row.verified_at == null ? null : String(row.verified_at),
    task_id: row.task_id == null ? null : String(row.task_id),
    created_at: String(row.created_at ?? ''),
  };
}

function mapTask(row: Record<string, unknown>): GoalTaskRow {
  return {
    id: String(row.id),
    description: String(row.description ?? ''),
    status: String(row.status ?? 'open'),
    owner: row.owner == null ? null : String(row.owner),
    claimed_at: row.claimed_at == null ? null : String(row.claimed_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    created_at: String(row.created_at ?? ''),
  };
}

export class GoalStore {
  constructor(private readonly db: PGlite) {}

  async createGoal(goal: {
    id: string;
    title: string;
    description?: string;
    priority?: GoalRow['priority'];
    owner?: GoalRow['owner'];
    parentGoalId?: string;
    blockedBy?: string[];
    createdBy?: string;
  }): Promise<GoalRow> {
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO goals (id, title, description, priority, owner, parent_goal_id, blocked_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING *`,
      [
        goal.id,
        goal.title,
        goal.description ?? '',
        goal.priority ?? 'medium',
        goal.owner ?? 'agent',
        goal.parentGoalId ?? null,
        JSON.stringify(goal.blockedBy ?? []),
        goal.createdBy ?? '',
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('createGoal: INSERT returned no row');
    return mapGoal(row);
  }

  async getGoal(id: string): Promise<GoalRow | null> {
    const result = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM goals WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? mapGoal(row) : null;
  }

  async listGoals(filter?: {
    status?: string;
    priority?: string;
    owner?: string;
    parentGoalId?: string;
  }): Promise<GoalRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filter.status);
    }
    if (filter?.priority) {
      conditions.push(`priority = $${paramIdx++}`);
      params.push(filter.priority);
    }
    if (filter?.owner) {
      conditions.push(`owner = $${paramIdx++}`);
      params.push(filter.owner);
    }
    if (filter?.parentGoalId) {
      conditions.push(`parent_goal_id = $${paramIdx++}`);
      params.push(filter.parentGoalId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM goals ${where} ORDER BY created_at`,
      params,
    );
    return result.rows.map(mapGoal);
  }

  async setGoalStatus(
    id: string,
    status: GoalStatus,
    reason: string,
  ): Promise<GoalRow | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE goals SET
         status = $2,
         status_reason = $3,
         updated_at = NOW(),
         closed_at = CASE WHEN $2 = 'done' OR $2 = 'abandoned' THEN NOW() ELSE NULL END
       WHERE id = $1
       RETURNING *`,
      [id, status, reason],
    );
    const row = result.rows[0];
    return row ? mapGoal(row) : null;
  }

  async addGoalCriterion(criterion: {
    id: string;
    goalId: string;
    description: string;
  }): Promise<GoalCriterionRow> {
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO goal_criteria (id, goal_id, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [criterion.id, criterion.goalId, criterion.description],
    );
    const row = result.rows[0];
    if (!row) throw new Error('addGoalCriterion: INSERT returned no row');
    return mapCriterion(row);
  }

  async getGoalCriterion(id: string): Promise<GoalCriterionRow | null> {
    const result = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM goal_criteria WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? mapCriterion(row) : null;
  }

  async listGoalCriteria(goalId: string): Promise<GoalCriterionRow[]> {
    const result = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM goal_criteria WHERE goal_id = $1 ORDER BY created_at',
      [goalId],
    );
    return result.rows.map(mapCriterion);
  }

  async recordGoalCriterion(update: {
    id: string;
    status: 'met' | 'failed';
    evidence: string;
    verifiedBy: string;
  }): Promise<GoalCriterionRow | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE goal_criteria SET status = $2, evidence = $3, verified_by = $4, verified_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [update.id, update.status, update.evidence, update.verifiedBy],
    );
    const row = result.rows[0];
    return row ? mapCriterion(row) : null;
  }

  async resetGoalCriterion(id: string): Promise<GoalCriterionRow | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE goal_criteria SET
         status = 'pending', evidence = '', verified_by = NULL, verified_at = NULL, task_id = NULL
       WHERE id = $1 AND status = 'failed'
       RETURNING *`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapCriterion(row) : null;
  }

  async linkGoalCriterionTask(
    criterionId: string,
    taskId: string,
  ): Promise<GoalCriterionRow | null> {
    const result = await this.db.query<Record<string, unknown>>(
      'UPDATE goal_criteria SET task_id = $2 WHERE id = $1 RETURNING *',
      [criterionId, taskId],
    );
    const row = result.rows[0];
    return row ? mapCriterion(row) : null;
  }

  async createTask(task: { id: string; description: string }): Promise<GoalTaskRow> {
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO tasks (id, description, status) VALUES ($1, $2, 'open') RETURNING *`,
      [task.id, task.description],
    );
    const row = result.rows[0];
    if (!row) throw new Error('createTask: INSERT returned no row');
    return mapTask(row);
  }

  async getTask(id: string): Promise<GoalTaskRow | null> {
    const result = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM tasks WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? mapTask(row) : null;
  }

  async logEvent(event: {
    agentId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`,
      [event.agentId, event.eventType, JSON.stringify(event.payload)],
    );
  }
}
