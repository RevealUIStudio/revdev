/**
 * GAP-323 — in-process bus for design.pack.moved (pair of work-events.ts).
 *
 * Kept free of server imports so events.wait can subscribe without a cycle.
 */

import { EventEmitter } from 'node:events';

/** Stable event type written to the events table + bus. */
export const DESIGN_PACK_MOVED_EVENT = 'design.pack.moved';

export interface DesignPackMovedPayload {
  roots: string[];
  previousDigest: string | null;
  digest: string;
  changedFiles: string[];
  fileCount: number;
  at: string;
}

class DesignPackEventBus extends EventEmitter {
  emitMoved(payload: DesignPackMovedPayload): void {
    this.emit(DESIGN_PACK_MOVED_EVENT, payload);
  }
}

export const designPackEvents = new DesignPackEventBus();
designPackEvents.setMaxListeners(64);
