import { describe, it, expect, vi } from 'vitest';

import type { WakeGuard, WakeGuardResult } from './container-runner.js';
import type { MemoryAdmissionPriority } from './memory-admission.js';
import type { Session } from './types.js';

const wakeContainer = vi.fn();
vi.mock('./container-runner.js', () => ({
  wakeContainer: (session: Session, priority?: MemoryAdmissionPriority, options?: { guard?: WakeGuard }) =>
    wakeContainer(session, priority, options),
}));

import { requestWake, type WakeReason } from './request-wake.js';

const session = { id: 's-1', agent_group_id: 'g-1' } as Session;

const ALL_REASONS: WakeReason[] = [
  'inbound-message',
  'due-message',
  'container-restart',
  'self-mod-apply',
  'agent-created',
  'cli',
  'approval-response',
  'adoption',
];

describe('requestWake', () => {
  it('is a pure delegation to wakeContainer (role=all byte-equivalence)', async () => {
    wakeContainer.mockResolvedValueOnce(true);
    expect(await requestWake(session, 'inbound-message')).toBe(true);
    expect(wakeContainer).toHaveBeenLastCalledWith(session, undefined, { guard: undefined });

    wakeContainer.mockResolvedValueOnce(false);
    expect(await requestWake(session, 'due-message')).toBe(false);
  });

  it.each(ALL_REASONS)(
    "a reason-only call ('%s') is byte-equivalent to today's bare wakeContainer call",
    async (reason) => {
      wakeContainer.mockClear();
      wakeContainer.mockResolvedValueOnce(true);
      await requestWake(session, reason);
      // The reason never reaches wakeContainer: default priority (undefined,
      // which wakeContainer itself defaults to 'interactive') and no guard,
      // identical to what `wakeContainer(session)` passes today.
      expect(wakeContainer).toHaveBeenCalledWith(session, undefined, { guard: undefined });
    },
  );

  it('priority passes through unchanged', async () => {
    wakeContainer.mockClear();
    wakeContainer.mockResolvedValueOnce(true);
    await requestWake(session, 'due-message', { priority: 'scheduled' });
    expect(wakeContainer).toHaveBeenCalledWith(session, 'scheduled', { guard: undefined });
  });

  it('the guard passes through by identity', async () => {
    wakeContainer.mockClear();
    wakeContainer.mockResolvedValueOnce(true);
    const guard: WakeGuard = () => true as WakeGuardResult;
    await requestWake(session, 'container-restart', { guard });
    expect(wakeContainer).toHaveBeenCalledWith(session, undefined, { guard });
    const call = wakeContainer.mock.calls[0];
    expect(call[2].guard).toBe(guard);
  });

  it('requestWake resolves false when wakeContainer does (its documented never-throws contract, src/router.ts:1553-1556)', async () => {
    wakeContainer.mockClear();
    wakeContainer.mockResolvedValueOnce(false);
    expect(await requestWake(session, 'inbound-message')).toBe(false);
  });

  it('is a pure passthrough — it adds no catch of its own, so it never masks a real wakeContainer defect', async () => {
    wakeContainer.mockClear();
    wakeContainer.mockRejectedValueOnce(new Error('boom'));
    await expect(requestWake(session, 'inbound-message')).rejects.toThrow('boom');
  });
});
