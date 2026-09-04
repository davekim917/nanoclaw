/**
 * Production wiring check (series-wide rule, added after Codex flagged it on
 * PR 7): every family PR's own test file imports its module directly
 * (`./index.js`), which proves the registration WORKS but never proves the
 * production barrel (`src/modules/index.ts` — the file `src/index.ts`
 * imports for side effects, the one real `main.ts` boot actually loads)
 * carries the one import line that reaches it. A module that registers
 * correctly but is missing from the barrel is dark in production while every
 * unit test still passes.
 *
 * Hermeticity: this file imports the WHOLE production barrel, so it arms the
 * same `child_process` tripwire as `health.test.ts` and mocks the handful of
 * seams other barrel modules touch at import time (never at call time, since
 * nothing here invokes a handler) that would otherwise reach real state —
 * discovered empirically by importing the barrel and mocking exactly what it
 * required, no more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawns = vi.hoisted(() => [] as string[]);
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
vi.mock('child_process', () => childProcessTripwire(spawns));
vi.mock('node:child_process', () => childProcessTripwire(spawns));

afterEach(() => {
  expect(spawns).toEqual([]);
  vi.resetModules();
});

describe('the production modules barrel registers the container-health duty source', () => {
  it('S11 and S14 are registered duties, and S16 is a registered SLA-observation hook, after importing the real barrel', async () => {
    // The real barrel (`src/modules/index.js`) — the same file `src/index.ts`
    // imports for production side effects, NOT `./index.js` (this family's
    // own module, which every other case in this directory already proves
    // registers correctly in isolation).
    await import('../index.js');
    const { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY } = await import('../../host-sweep.js');

    const { duties, slaObservationHooks } = _listSweepRegistrationsForTesting();
    expect(duties.some((d) => d.name === SWEEP_DUTY_INVENTORY.S11)).toBe(true);
    expect(duties.some((d) => d.name === SWEEP_DUTY_INVENTORY.S14)).toBe(true);
    expect(slaObservationHooks.some((h) => h.name === SWEEP_DUTY_INVENTORY.S16)).toBe(true);
  });
});
