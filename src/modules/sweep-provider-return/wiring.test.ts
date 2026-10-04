import { expect, it, vi } from 'vitest';

const spawns = vi.hoisted(() => [] as string[]);
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => {
    spawns.push(`execFileSync ${JSON.stringify(args[0])}`);
    throw new Error('wiring.test: real process spawn attempted');
  },
  execSync: () => spawns.push('execSync'),
  spawn: () => spawns.push('spawn'),
  exec: () => spawns.push('exec'),
  execFile: () => spawns.push('execFile'),
  spawnSync: () => spawns.push('spawnSync'),
  fork: () => spawns.push('fork'),
}));

it('importing src/modules/index.ts registers provider-fallback-return on session:health', async () => {
  const { _listSweepRegistrationsForTesting, _resetSweepRegistryForTesting, SWEEP_DUTY_INVENTORY } =
    await import('../../host-sweep.js');
  _resetSweepRegistryForTesting({ builtins: false });

  await import('../index.js');

  const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.FORK6);
  expect(duty).toMatchObject({ phase: 'session:health', order: 15 });
  expect(spawns).toEqual([]);
});
