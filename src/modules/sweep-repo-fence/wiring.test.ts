/**
 * Series-wide follow-up (PR 7's Codex round, issue #308): the registry
 * test's direct `import './index.js'` (see repo-fence.test.ts) proves the
 * duty registrations are CORRECT, but not that anything in production
 * actually loads this family module — a forgotten line in
 * `src/modules/index.ts` would ship silently. This file drives the real
 * production barrel instead.
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * Hermeticity HARD RULE (brief-common.md step 2). The barrel pulls in every
 * default-tier module; none of them has a legitimate reason to shell out at
 * import time. Reused from `src/host-sweep-registry.test.ts`'s factory.
 */
const spawns: string[] = vi.hoisted(() => [] as string[]);
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

describe('the production modules barrel registers the repo-fence duty source', () => {
  it('src/modules/index.ts registers T5 and T22', async () => {
    // The real barrel, unmocked apart from the tripwire above — every other
    // default-tier module registers itself (delivery-action handlers,
    // response handlers, lifecycle callbacks) without touching a real
    // process, DB, or network at import time; nothing here calls any of
    // them, so nothing beyond registration ever runs.
    await import('../index.js');
    const { SWEEP_DUTY_INVENTORY, _listSweepRegistrationsForTesting } = await import('../../host-sweep.js');

    const { duties } = _listSweepRegistrationsForTesting();
    const names = new Set(duties.map((d) => d.name));
    expect(names.has(SWEEP_DUTY_INVENTORY.T5)).toBe(true);
    expect(names.has(SWEEP_DUTY_INVENTORY.T22)).toBe(true);

    expect(spawns).toEqual([]);
  });
});
