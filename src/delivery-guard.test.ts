import { describe, expect, it, vi } from 'vitest';
vi.mock('./db/central-lease.js', () => ({ withCentralSync: async (fn: () => unknown) => fn() }));
vi.mock('./guard/index.js', () => ({ guard: vi.fn(() => ({ effect: 'allow', reason: 'test' })) }));
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: () => false,
  log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
import { runGuarded, type DeliveryGuardSpec } from './delivery-guard.js';
import { guard } from './guard/index.js';
import type { Session } from './types.js';

const session = { id: 'session', agent_group_id: 'group' } as Session;
const spec = { guardAction: {}, requestHold: vi.fn(async () => {}) } as unknown as DeliveryGuardSpec;
describe('guarded delivery acknowledgement ownership', () => {
  it('preserves a detached handler deferAck so the outer delivery loop cannot prematurely mark it delivered', async () => {
    expect(await runGuarded('test', spec, async () => ({ deferAck: true }), {}, session, null)).toEqual({
      deferAck: true,
    });
  });
  it('ordinary guarded actions still return void and execute once', async () => {
    const handler = vi.fn(async () => {});
    expect(await runGuarded('test', spec, handler, {}, session, null)).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
  });
  it('a deny or hold cannot start the detached job', async () => {
    const handler = vi.fn(async () => ({ deferAck: true as const }));
    vi.mocked(guard).mockReturnValueOnce({ effect: 'deny', reason: 'test' });
    expect(await runGuarded('test', spec, handler, {}, session, null)).toBeUndefined();
    vi.mocked(guard).mockReturnValueOnce({ effect: 'hold', reason: 'test' });
    expect(await runGuarded('test', spec, handler, {}, session, null)).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(spec.requestHold).toHaveBeenCalledOnce();
  });
});
