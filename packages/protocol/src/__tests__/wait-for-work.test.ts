/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import { WORK_COMPLETED_EVENT, waitForWorkCompleted } from '../wait-for-work.js';

describe('waitForWorkCompleted', () => {
  it('calls events.wait with work.completed defaults', async () => {
    const rpc = vi.fn().mockResolvedValue({
      event: { id: 1, event_type: WORK_COMPLETED_EVENT },
      timedOut: false,
    });
    const result = await waitForWorkCompleted(rpc);
    expect(rpc).toHaveBeenCalledWith('events.wait', {
      eventType: WORK_COMPLETED_EVENT,
      sinceId: 0,
      timeoutMs: 30_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.event).toEqual({ id: 1, event_type: WORK_COMPLETED_EVENT });
  });

  it('forwards sinceId and timeoutMs', async () => {
    const rpc = vi.fn().mockResolvedValue({ event: null, timedOut: true });
    const result = await waitForWorkCompleted(rpc, { sinceId: 9, timeoutMs: 500 });
    expect(rpc).toHaveBeenCalledWith('events.wait', {
      eventType: WORK_COMPLETED_EVENT,
      sinceId: 9,
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.event).toBeNull();
  });
});
