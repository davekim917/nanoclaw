/**
 * Production wiring check (series-wide rule, added after Codex flagged it on
 * PR 7): every family PR's own test file imports its module directly
 * (`./index.js`), which proves the registration WORKS but never proves the
 * production barrel (`src/modules/index.ts` — the file `src/index.ts` imports
 * for side effects, the one real `main.ts` boot actually loads) carries the
 * import line that reaches it. A module that registers correctly but is
 * missing from the barrel is dark in production while every unit test still
 * passes.
 *
 * Hermeticity: this file imports the WHOLE production barrel, so it arms the
 * same `child_process` tripwire as `continuation.test.ts`. Nothing here
 * invokes a handler — every barrel module registers as a pure module-eval
 * side effect — so no other seam mock is needed.
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

describe('the production modules barrel registers the continuation duty source', () => {
  it('the production modules barrel registers the continuation duty source', async () => {
    // The real barrel (`src/modules/index.js`) — the same file `src/index.ts`
    // imports for production side effects, NOT `./index.js` (this family's own
    // module, which every case in continuation.test.ts already covers).
    await import('../index.js');
    const { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY } = await import('../../host-sweep.js');

    const { duties, killFollowUps } = _listSweepRegistrationsForTesting();
    const dutyNames = duties.map((d) => d.name);
    for (const id of ['S6', 'S7', 'S8', 'S9a', 'S9b'] as const) {
      expect(dutyNames, `duty ${id}`).toContain(SWEEP_DUTY_INVENTORY[id]);
    }
    const followUpNames = killFollowUps.map((f) => f.name);
    expect(followUpNames).toContain(SWEEP_DUTY_INVENTORY.S15);
    expect(followUpNames).toContain(SWEEP_DUTY_INVENTORY.S10);
  });
});
