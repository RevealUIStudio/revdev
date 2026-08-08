/**
 * Goal contracts — row shapes + create input (roadmap-goal-spine PR0).
 *
 * Ported from retired @revealui/harnesses goals/ types. Zod validates create
 * input only; transitions are enforced by GoalHarness.
 */

import { z } from 'zod';

export const GOAL_STATUSES = ['open', 'active', 'blocked', 'done', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_PRIORITIES = ['blocker', 'high', 'medium', 'low'] as const;
export type GoalPriority = (typeof GOAL_PRIORITIES)[number];

export const GOAL_OWNERS = ['agent', 'human'] as const;
export type GoalOwner = (typeof GOAL_OWNERS)[number];

export const CRITERION_STATUSES = ['pending', 'met', 'failed'] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

export const GOAL_ACTIONS = ['propose-task', 'await-task', 'verify', 'rework'] as const;
export type GoalAction = (typeof GOAL_ACTIONS)[number];

/** Goal row shape (PGlite). */
export interface GoalRow {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  owner: GoalOwner;
  parent_goal_id: string | null;
  blocked_by: string[];
  created_by: string;
  status_reason: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** Goal acceptance-criterion row shape. */
export interface GoalCriterionRow {
  id: string;
  goal_id: string;
  description: string;
  status: CriterionStatus;
  evidence: string;
  verified_by: string | null;
  verified_at: string | null;
  task_id: string | null;
  created_at: string;
}

/** Task row fields the harness reads (subset of daemon tasks table). */
export interface GoalTaskRow {
  id: string;
  description: string;
  status: string;
  owner: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export const createGoalInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  priority: z.enum(GOAL_PRIORITIES).default('medium'),
  owner: z.enum(GOAL_OWNERS).default('agent'),
  parentGoalId: z.string().min(1).optional(),
  blockedBy: z.array(z.string().min(1)).default([]),
  criteria: z.array(z.string().min(1).max(1000)).default([]),
  /** Optional stable id (e.g. gap-318); otherwise harness generates goal-UUID. */
  id: z.string().min(1).max(120).optional(),
});
export type CreateGoalInput = z.input<typeof createGoalInputSchema>;

export interface GoalWithCriteria {
  goal: GoalRow;
  criteria: GoalCriterionRow[];
}

export interface GoalProgress {
  goalId: string;
  status: GoalStatus;
  criteria: { total: number; met: number; failed: number; pending: number };
  tasks: { total: number; completed: number; claimed: number; open: number };
  percent: number;
  readyToComplete: boolean;
  unmet: string[];
}

export interface GoalActionItem {
  criterionId: string;
  description: string;
  action: GoalAction;
  taskId: string | null;
}
