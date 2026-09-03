/**
 * Acceptance cases for the claims sweep family (convergence seam 2, S2-PR6 —
 * F-6.1 in docs/specs/upstream-host-sweep-seam/plan.md §8). F-6.3 (order +
 * cross-duty visibility) lives in src/host-sweep-registry.test.ts — a
 * registry-level property, not a property of this module's own code, same
 * split S2-PR5's F-5.4 used.
 *
 * F-6.1 ("the self-heal nudge ladder keeps its 24h per-claim cooldown and
 * 10-minute scan throttle — the 92 ported claims cases"): the 93 cases that
 * exercise this behavior already live beside the claims logic itself —
 * `../claims/reconcile.test.ts` (21), `../claims/self-heal.test.ts` (51) and
 * `../claims/escalation.test.ts` (21) — and were never inside
 * host-sweep.test.ts to move: T20/T21's pre-move bodies in host-sweep.ts were
 * already thin `registerSweepDuty` wrappers around `reconcileMergedClaims`/
 * `sweepClaimsSelfHeal`, calling logic that predates the sweep registry and
 * is owned elsewhere (mailbox PR 7 converts self-heal.ts's internals with its
 * exported signature explicitly UNCHANGED — plan.md §5). Moving those
 * pre-existing suites into this file would touch code outside S2-PR6's
 * ownership for no behavior change, so they stay put, untouched. What DID
 * move is the ~30-line wrapper each duty sat behind — the cases below drive
 * exactly that move, per the family-case rule (brief-family-template.md,
 * added 2026-09-03 after Codex hit PR 4 and PR 8): obtain each duty from the
 * registry by name (the same accessor R-7 uses), invoke `run(ctx)`, and
 * assert the underlying dependency was reached and the preserved failure log
 * string fires on a throw.
 *
 * Hermeticity (brief-common.md HARD RULE): importing this module's ./index.js
 * registers T20/T21 at import — registration only pushes duty objects into an
 * array (no body executes), and host-sweep.ts's own import graph is inert at
 * import time (S2-PR5's orchestrator.test.ts documents the same property).
 * child_process is tripwired below regardless, since a real
 * reconcileMergedClaims/sweepClaimsSelfHeal implementation reaches GitHub and
 * git — both are mocked here so no real call is possible even if a mock were
 * removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnAttempts = vi.hoisted(() => [] as string[]);

function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const attempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`sweep-claims/claims.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
    };
  return {
    exec: attempted('exec'),
    execFile: attempted('execFile'),
    execSync: attempted('execSync'),
    execFileSync: attempted('execFileSync'),
    spawn: attempted('spawn'),
    spawnSync: attempted('spawnSync'),
    fork: attempted('fork'),
  };
}

vi.mock('child_process', () => childProcessTripwire(spawnAttempts));
vi.mock('node:child_process', () => childProcessTripwire(spawnAttempts));

afterEach(() => {
  expect(spawnAttempts).toEqual([]);
  spawnAttempts.length = 0;
});

const mockReconcileMergedClaims = vi.fn();
const mockSweepClaimsSelfHeal = vi.fn();

vi.mock('../claims/reconcile.js', () => ({
  reconcileMergedClaims: (...args: unknown[]) => mockReconcileMergedClaims(...args),
}));
vi.mock('../claims/self-heal.js', () => ({
  sweepClaimsSelfHeal: (...args: unknown[]) => mockSweepClaimsSelfHeal(...args),
}));

// Registers T20/T21 into host-sweep.ts's live registry — needed so the cases
// below can obtain them by name, the same accessor R-7 uses in
// src/host-sweep-registry.test.ts. Safe to import unmocked: registration is
// inert at import time (see docstring above).
import './index.js';
import { _listSweepRegistrationsForTesting, type SweepTickContext } from '../../host-sweep.js';
import { log } from '../../log.js';

function fakeTickContext(): SweepTickContext {
  return { now: Date.now(), sessions: [], activeContainerSessionIds: new Set() } as unknown as SweepTickContext;
}

function getDuty(name: string) {
  const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === name);
  if (!duty) throw new Error(`duty ${name} not registered`);
  return duty;
}

describe('the self-heal nudge ladder keeps its 24h per-claim cooldown and 10-minute scan throttle', () => {
  // F-6.1: the 92/93 ported cases proving the cooldown/throttle behavior live
  // in ../claims/self-heal.test.ts (`describe('ladder', ...)`,
  // `describe('throttle', ...)`) and ../claims/reconcile.test.ts — see the
  // docstring above for why they were not moved. This case proves the
  // REGISTERED T21 wrapper is the thing that actually reaches
  // sweepClaimsSelfHeal, so that pre-existing behavior is exercised in
  // production, not bypassed by the move.
  beforeEach(() => {
    mockSweepClaimsSelfHeal.mockReset();
  });

  it('run(ctx) calls sweepClaimsSelfHeal with no arguments', async () => {
    const duty = getDuty('claims-self-heal');

    await duty.run(fakeTickContext());

    expect(mockSweepClaimsSelfHeal).toHaveBeenCalledTimes(1);
    expect(mockSweepClaimsSelfHeal).toHaveBeenCalledWith();
  });
});

describe('the registered claims-reconcile wrapper calls reconcileMergedClaims', () => {
  beforeEach(() => {
    mockReconcileMergedClaims.mockReset();
  });

  it('run(ctx) calls reconcileMergedClaims with no arguments', async () => {
    const duty = getDuty('claims-reconcile');

    await duty.run(fakeTickContext());

    expect(mockReconcileMergedClaims).toHaveBeenCalledTimes(1);
    expect(mockReconcileMergedClaims).toHaveBeenCalledWith();
  });

  it('a failure inside reconcileMergedClaims logs the preserved string and does not reject', async () => {
    // T20's own try/catch (moved unchanged) is what the pre-move body relied
    // on — this proves the move kept it.
    const duty = getDuty('claims-reconcile');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    mockReconcileMergedClaims.mockImplementationOnce(async () => {
      throw new Error('reconcile boom');
    });

    await expect(duty.run(fakeTickContext())).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Claims reconcile sweep step failed', expect.objectContaining({}));
    warn.mockRestore();
  });
});

describe('the registered claims-self-heal wrapper calls sweepClaimsSelfHeal', () => {
  beforeEach(() => {
    mockSweepClaimsSelfHeal.mockReset();
  });

  it('a failure inside sweepClaimsSelfHeal logs the preserved string and does not reject', async () => {
    const duty = getDuty('claims-self-heal');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    mockSweepClaimsSelfHeal.mockImplementationOnce(async () => {
      throw new Error('self-heal boom');
    });

    await expect(duty.run(fakeTickContext())).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Claims self-heal sweep step failed', expect.objectContaining({}));
    warn.mockRestore();
  });
});
