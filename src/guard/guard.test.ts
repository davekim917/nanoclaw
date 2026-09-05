/**
 * Guard decision-function unit tests: decide is the decision (allow /
 * hold / deny returned as-is), grant semantics (satisfies holds, never
 * denies; invalid → refuse), the runtime backstop against forged action
 * values, and the fail-closed posture on a throwing decide.
 *
 * Uses synthetic actions defined per test — the catalog is per-worker module
 * state with no reset, so action names are unique.
 *
 * guard() is synchronous by design (seam-3 plan §4.5, I-1) — its central
 * reads run on the raw handle, never awaited — so these tests call it
 * directly with no await.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { guard } from './guard.js';
import { defineGuardedAction, type GuardedAction } from './guard-actions.js';
import { ALLOW, DENY, HOLD, type GuardInput } from './types.js';

const mockGetRawDb = vi.fn();
vi.mock('../db/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/connection.js')>()),
  getRawDb: (...args: unknown[]) => mockGetRawDb(...args),
}));
// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

const AGENT = { kind: 'agent', agentGroupId: 'ag-1', sessionId: 'sess-1' } as const;

function input(extra: Partial<GuardInput> = {}): GuardInput {
  return { actor: AGENT, payload: {}, ...extra };
}

/** Stubs the raw handle so `getRawDb().prepare(sql).get(id)` returns `row`. */
function stubPendingApprovalRow(row: unknown): void {
  mockGetRawDb.mockReturnValue({
    prepare: () => ({
      get: () => row,
    }),
  });
}

beforeEach(() => {
  mockGetRawDb.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('decide is the decision', () => {
  it('decide allow → allow', () => {
    const action = defineGuardedAction({ action: 't.allow1', decide: () => ALLOW('ok') });
    expect(guard(action, input()).effect).toBe('allow');
  });

  it('decide hold → hold, default approver chain', () => {
    const action = defineGuardedAction({ action: 't.hold1', decide: () => HOLD('needs approval') });
    const d = guard(action, input());
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') {
      expect(d.reason).toBe('needs approval');
      expect(d.approverUserId).toBeUndefined();
    }
  });

  it('decide hold → hold, carrying a named approver', () => {
    const action = defineGuardedAction({ action: 't.hold2', decide: () => HOLD('policy row', 'telegram:dana') });
    const d = guard(action, input());
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') expect(d.approverUserId).toBe('telegram:dana');
  });

  it('decide deny → deny, carrying the reason', () => {
    const action = defineGuardedAction({ action: 't.deny1', decide: () => DENY('structurally unauthorized') });
    const d = guard(action, input());
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('structurally unauthorized');
  });

  it('a forged action value (not from defineGuardedAction) is denied', () => {
    const forged = { action: 't.forged', decide: () => ALLOW('never vetted') } as unknown as GuardedAction;
    const d = guard(forged, input());
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toContain('undefined action');
  });
});

describe('grants', () => {
  const grantRow = (action: string) =>
    ({ approval_id: 'appr-1', action, payload: '{}' }) as unknown as NonNullable<GuardInput['grant']>;

  it('a valid live grant satisfies a hold', () => {
    const action = defineGuardedAction({
      action: 't.g1',
      grantActionName: 'g1_approved',
      decide: () => HOLD('b'),
    });
    const grant = grantRow('g1_approved');
    stubPendingApprovalRow({ approval_id: 'appr-1', action: 'g1_approved' });
    expect(guard(action, input({ grant })).effect).toBe('allow');
  });

  it('a grant never satisfies a deny — the checks re-run live', () => {
    const action = defineGuardedAction({
      action: 't.g2',
      grantActionName: 'g2_approved',
      decide: () => DENY('revoked since'),
    });
    const grant = grantRow('g2_approved');
    stubPendingApprovalRow({ approval_id: 'appr-1', action: 'g2_approved' });
    const d = guard(action, input({ grant }));
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('revoked since');
  });

  it('a dead grant (row deleted) refuses instead of re-holding', () => {
    const action = defineGuardedAction({
      action: 't.g3',
      grantActionName: 'g3_approved',
      decide: () => HOLD('b'),
    });
    stubPendingApprovalRow(undefined);
    const d = guard(action, input({ grant: grantRow('g3_approved') }));
    expect(d.effect).toBe('deny');
  });

  it("a grant for a different action doesn't transfer", () => {
    const action = defineGuardedAction({
      action: 't.g4',
      grantActionName: 'g4_approved',
      decide: () => HOLD('b'),
    });
    const grant = grantRow('other_action');
    stubPendingApprovalRow({ approval_id: 'appr-1', action: 'other_action' });
    expect(guard(action, input({ grant })).effect).toBe('deny');
  });

  it('a domain grantCoversRequest binding can refuse a payload mismatch', () => {
    const action = defineGuardedAction({
      action: 't.g5',
      grantActionName: 'g5_approved',
      grantCoversRequest: () => false,
      decide: () => HOLD('b'),
    });
    const grant = grantRow('g5_approved');
    stubPendingApprovalRow({ approval_id: 'appr-1', action: 'g5_approved' });
    expect(guard(action, input({ grant })).effect).toBe('deny');
  });

  it('a grant on an already-allowed action is a no-op', () => {
    const action = defineGuardedAction({
      action: 't.g6',
      grantActionName: 'g6_approved',
      decide: () => ALLOW('ok'),
    });
    const grant = grantRow('g6_approved');
    stubPendingApprovalRow({ approval_id: 'appr-1', action: 'g6_approved' });
    expect(guard(action, input({ grant })).effect).toBe('allow');
  });
});

describe('fail-closed posture', () => {
  it('a throwing decide denies', () => {
    const action = defineGuardedAction({
      action: 't.f1',
      decide: () => {
        throw new Error('boom');
      },
    });
    expect(guard(action, input()).effect).toBe('deny');
  });
});
