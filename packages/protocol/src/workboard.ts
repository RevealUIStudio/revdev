/**
 * Workboard protocol types for multi-agent coordination.
 *
 * The workboard is the shared coordination primitive that lets
 * multiple AI coding agents work safely in parallel.
 */

/** Valid task statuses. */
export type TaskStatus = 'available' | 'claimed' | 'partial' | 'blocked' | 'done';

/** Valid task priorities. */
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';

/** A row in the Agents table (managed by hooks). */
export interface WorkboardAgent {
  id: string;
  env: string;
  started: string;
  task: string;
  files: string;
  updated: string;
}

/** A row in the Tasks table (managed by agents). */
export interface WorkboardTask {
  id: string;
  task: string;
  pri: TaskPriority;
  status: TaskStatus;
  owner: string;
  gh: string;
  updated: string;
  notes: string;
}

/** A row in the Blocked table. */
export interface WorkboardBlockedTask {
  id: string;
  task: string;
  blocker: string;
  gh: string;
  notes: string;
}

/** A row in the Done table. */
export interface WorkboardDoneTask {
  id: string;
  task: string;
  owner: string;
  completed: string;
  gh: string;
  notes: string;
}

/** Full parsed workboard state. */
export interface WorkboardState {
  preamble: string[];
  agents: WorkboardAgent[];
  tasks: WorkboardTask[];
  blocked: WorkboardBlockedTask[];
  done: WorkboardDoneTask[];
  log: string[];
  _extra: Record<string, string>;
}

/** Result of a conflict detection check. */
export interface ConflictResult {
  clean: boolean;
  conflicts: Array<{
    thisSession: string;
    otherSession: string;
    overlappingFiles: string[];
  }>;
}
