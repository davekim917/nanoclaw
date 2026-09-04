/**
 * Acceptance case for the egress sweep family (convergence seam 2, S2-PR6).
 * T2's phase assertion (F-6.4, "egress re-heal runs before the session
 * fan-out") lives in src/host-sweep-registry.test.ts, alongside F-6.3 — it is
 * a registry-level property (phase placement), not a property of this
 * module's own code, matching the pattern S2-PR5's F-5.4 set.
 *
 * This file carries the family-case rule (brief-family-template.md, added
 * 2026-09-03 after Codex hit PR 4 and PR 8): a case that calls the moved body
 * directly proves nothing about the REGISTERED wrapper. Both cases below
 * obtain T2 from the registry by name (the same accessor R-7 uses) and
 * invoke `run(ctx)`.
 *
 * Hermeticity (brief-common.md HARD RULE): importing this module registers
 * T2 at import — registration only pushes a duty object into an array (no
 * body executes), and host-sweep.ts's own import graph is inert at import
 * time (S2-PR5's orchestrator.test.ts documents the same property). T2's
 * body calls `ensureEgressNetwork`, mocked below — no real Docker network
 * call is possible even if the mock were removed, since node's `child_process`
 * is also tripwired here and the case that removes the mock proves it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnAttempts = vi.hoisted(() => [] as string[]);

function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const attempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`sweep-egress/egress.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

const mockEnsureEgressNetwork = vi.fn();

vi.mock('../../egress-lockdown.js', () => ({
  ensureEgressNetwork: (...args: unknown[]) => mockEnsureEgressNetwork(...args),
}));

// Registers T2 into host-sweep.ts's live registry — needed so the cases below
// can obtain it by name, the same accessor R-7 uses in
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

describe('the registered egress-network-reheal wrapper calls ensureEgressNetwork', () => {
  beforeEach(() => {
    mockEnsureEgressNetwork.mockReset();
  });

  it('run(ctx) calls ensureEgressNetwork with no arguments', () => {
    const duty = getDuty('egress-network-reheal');

    duty.run(fakeTickContext());

    expect(mockEnsureEgressNetwork).toHaveBeenCalledTimes(1);
    expect(mockEnsureEgressNetwork).toHaveBeenCalledWith();
  });

  it('a failure inside ensureEgressNetwork logs the preserved string and does not throw', () => {
    // T2's own try/catch (moved unchanged) is what the pre-move body relied
    // on — this proves the move kept it.
    const duty = getDuty('egress-network-reheal');
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    mockEnsureEgressNetwork.mockImplementationOnce(() => {
      throw new Error('lockdown boom');
    });

    expect(() => duty.run(fakeTickContext())).not.toThrow();

    expect(error).toHaveBeenCalledWith('Egress lockdown re-heal failed', expect.objectContaining({}));
    error.mockRestore();
  });
});
