/**
 * GAP-362 — work completion push feed (auto-notify over poll).
 *
 * Complements durable rows in `events` (events.log / events.query). In-process
 * harnesses and `events.wait` subscribe here so customers do not need a
 * self-scheduled poll to learn a tracked task completed.
 */

import { EventEmitter } from 'node:events';

/** Stable event type written to the events table + bus. */
export const WORK_COMPLETED_EVENT = 'work.completed';

export interface WorkCompletedEvent {
  taskId: string;
  agentId: string;
  summary: string | null;
  /** events table id when dual-written; null if insert skipped. */
  eventId: number | null;
  at: string;
}

class WorkEventBus extends EventEmitter {
  emitCompleted(evt: WorkCompletedEvent): void {
    this.emit(WORK_COMPLETED_EVENT, evt);
  }
}

export const workEvents = new WorkEventBus();
workEvents.setMaxListeners(64);
