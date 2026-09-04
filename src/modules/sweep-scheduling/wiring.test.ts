/**
 * Production wiring check (series-wide rule, added after Codex flagged it on
 * PR 7): `scheduling.test.ts` imports this family's module directly
 * (`./index.js`), which proves the registration WORKS but never proves the
 * production barrel (`src/modules/index.ts` — the file `src/index.ts` imports
 * for side effects, the one real `main.ts` boot loads) carries the import line
 * that reaches it. A module that registers correctly but is missing from the
 * barrel is dark in production while every unit test still passes.
 *
 * Hermeticity: this file imports the WHOLE production barrel, so it arms the
 * same `child_process` tripwire and mocks only the seams other barrel modules
 * touch at import time — nothing here invokes a handler.
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

describe('the production modules barrel registers the scheduling duty source', () => {
  it('the production modules barrel registers the scheduling duty source', async () => {
    // T8, S5, S18 and S19 are registered duties after importing the real
    // barrel (`src/modules/index.js`) — NOT `./index.js`, which every other
    // case in this directory already proves registers in isolation.
    await import('../index.js');
    const { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY } = await import('../../host-sweep.js');

    const names = new Set(_listSweepRegistrationsForTesting().duties.map((d) => d.name));
    expect(names.has(SWEEP_DUTY_INVENTORY.T8)).toBe(true);
    expect(names.has(SWEEP_DUTY_INVENTORY.S5)).toBe(true);
    expect(names.has(SWEEP_DUTY_INVENTORY.S18)).toBe(true);
    expect(names.has(SWEEP_DUTY_INVENTORY.S19)).toBe(true);
  });
});
