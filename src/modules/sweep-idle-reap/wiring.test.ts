/**
 * Wiring proof (seam 2, series-wide follow-up from PR 7's Codex round, added
 * 2026-09-03): every family's own test file imports its module DIRECTLY
 * (`./index.js`), which registers it on the sweep registry regardless of
 * whether `src/modules/index.ts` — the barrel `main.ts` actually loads at
 * boot — also imports it. That direct import masks a missing barrel line: R-7
 * and the "two idle reaps" case would both stay green even if the one import
 * this family added to `src/modules/index.ts` were deleted.
 *
 * This file proves the PRODUCTION path instead: it imports ONLY the barrel
 * (`../index.js` = `src/modules/index.ts`) — never `./index.js` directly —
 * and asserts the idle-reap duties came along for the ride.
 *
 * Hermeticity (brief-common.md HARD RULE): the barrel transitively imports
 * every default module (approvals, self-mod, orchestrator-dispatch, etc.).
 * None of them do real I/O merely by being imported — registration only, same
 * as this family's own module — verified by running this file with NO seam
 * mocks beyond the child_process tripwire and observing a clean import; the
 * tripwire is armed and asserted empty regardless, per the HARD RULE.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawns: [] as string[] }));

function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`wiring.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
    };
  return {
    exec: spawnAttempted('exec'),
    execFile: spawnAttempted('execFile'),
    spawn: spawnAttempted('spawn'),
    execSync: spawnAttempted('execSync'),
    execFileSync: spawnAttempted('execFileSync'),
    spawnSync: spawnAttempted('spawnSync'),
    fork: spawnAttempted('fork'),
  };
}

vi.mock('child_process', () => childProcessTripwire(h.spawns));
vi.mock('node:child_process', () => childProcessTripwire(h.spawns));

describe('the production modules barrel registers the idle-reap duty source', () => {
  it('importing src/modules/index.ts alone (never this module directly) registers S12/S13', async () => {
    const { _listSweepRegistrationsForTesting, _resetSweepRegistryForTesting, SWEEP_DUTY_INVENTORY } =
      await import('../../host-sweep.js');
    // A clean slate: only host-sweep.ts's own in-file builtins, nothing from
    // any family module yet — the barrel import below is what must supply
    // sweep-idle-reap's two duties, not a direct import anywhere in this file.
    _resetSweepRegistryForTesting({ builtins: false });

    await import('../index.js');

    const { duties } = _listSweepRegistrationsForTesting();
    const names = new Set(duties.map((d) => d.name));
    expect(names.has(SWEEP_DUTY_INVENTORY.S12)).toBe(true);
    expect(names.has(SWEEP_DUTY_INVENTORY.S13)).toBe(true);

    expect(h.spawns).toEqual([]);
  });
});
