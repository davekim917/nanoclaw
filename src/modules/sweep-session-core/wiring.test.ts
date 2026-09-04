/**
 * Production wiring check (series-wide rule, added after Codex flagged it on
 * PR 7): every family PR's own test file imports its module directly
 * (`./index.js`), which proves the registration WORKS but never proves the
 * production barrel (`src/modules/index.ts` — the file `src/index.ts` imports
 * for side effects, the one real `main.ts` boot actually loads) carries the
 * one import line that reaches it. A module that registers correctly but is
 * missing from the barrel is dark in production while every unit test still
 * passes.
 *
 * Hermeticity: this file imports the WHOLE production barrel, so it arms the
 * same `child_process` tripwire as `session-core.test.ts`. Nothing here
 * invokes a handler, so import-time side effects are all that run.
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

describe('the production modules barrel registers the session-core duty source', () => {
  it('the production modules barrel registers the session-core duty source', async () => {
    // S2, S3, S4 and S17 are registered — S17 on both surfaces — after
    // importing the real barrel (`src/modules/index.js`), NOT `./index.js`
    // (this family's own module, which every case in session-core.test.ts
    // already proves registers correctly in isolation).
    await import('../index.js');
    const { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY } = await import('../../host-sweep.js');

    const { duties, killFollowUps } = _listSweepRegistrationsForTesting();
    const names = duties.map((d) => d.name);
    expect(names).toContain(SWEEP_DUTY_INVENTORY.S2);
    expect(names).toContain(SWEEP_DUTY_INVENTORY.S3);
    expect(names).toContain(SWEEP_DUTY_INVENTORY.S4);
    expect(names).toContain(SWEEP_DUTY_INVENTORY.S17);
    expect(killFollowUps.map((f) => f.name)).toContain(SWEEP_DUTY_INVENTORY.S17);
  });
});
