/**
 * Acceptance cases for the boot quiescence door (convergence seam 4, PR D1 —
 * docs/specs/upstream-restart-survival-seam/plan.md §7.D).
 *
 * The runtime listing is a fake: no `docker ps`, no `docker stop`. The
 * `child_process` tripwire below records and throws on any real spawn, and
 * every case asserts it stayed empty — the whole point of this door is that it
 * is the ONE place at boot that stops containers, so a stray spawn from
 * anywhere in the import graph is a finding, not noise.
 *
 * D1 is the measurement PR: the door partitions `mustStop` from `survivable`,
 * logs the counts, and then stops EVERYTHING, exactly as `cleanupOrphansStrict`
 * did. The "counted survivable — and still stopped" case is the one D2 flips.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawns = vi.hoisted(() => [] as string[]);

/** A tripwire, not a functional mock: it records the call and then throws. */
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`boot-quiescence.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

// The runtime door's dependencies are irrelevant here and expensive to load.
vi.mock('./container-runner.js', () => ({
  containerOwnsOutbound: vi.fn(() => false),
  getContainerSpawnedAt: vi.fn(() => 0),
  isContainerRunning: vi.fn(() => false),
  isContainerSpawning: vi.fn(() => false),
  killContainer: vi.fn(),
  sessionStillActive: vi.fn(() => true),
  wakeContainer: vi.fn(async () => undefined),
}));

// Stubbed so the module graph never reaches a real `docker ps`; every case
// injects its own listing through the primitive's runtime seam anyway.
vi.mock('./container-runtime.js', () => ({
  listInstallContainersWithScope: vi.fn(() => {
    throw new Error('container-runtime must not be reached in this suite');
  }),
  stopContainer: vi.fn(() => {
    throw new Error('container-runtime must not be reached in this suite');
  }),
}));

import { quiesceWorkgroupsForBootMountChange } from './container-restart.js';
import type { InstallContainerScope } from './container-runtime.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
  spawns.length = 0;
});

function container(name: string, workgroupId: string | null): InstallContainerScope {
  return { name, workgroupId, sessionId: `${name}-session`, groupId: `${name}-group` };
}

/**
 * A fake runtime: `list()` returns whatever is still "running", `stop()`
 * removes it. `stubborn` models a container that does not go away.
 */
/**
 * A fake runtime: `list()` returns whatever is still "running", `stop()`
 * removes it.
 *
 * `stubborn` models a container that does not go away. `arrivesLate` models one
 * that appears BETWEEN the two listings — another host, or a spawn racing the
 * boot. `failStopOf` models a stop that throws. `failListCall` models a docker
 * that goes away part way through the pass.
 */
function fakeRuntime(
  initial: InstallContainerScope[],
  opts: {
    stubborn?: string[];
    arrivesLate?: InstallContainerScope;
    failStopOf?: string;
    failListCall?: number;
  } = {},
) {
  let running = [...initial];
  const stops: string[] = [];
  const listings: number[] = [];
  let calls = 0;
  return {
    stops,
    listings,
    list: (): InstallContainerScope[] => {
      calls += 1;
      if (opts.failListCall === calls) {
        throw new Error('Cannot prove install-scoped container absence: runtime listing failed');
      }
      if (calls > 1 && opts.arrivesLate && !running.some((e) => e.name === opts.arrivesLate!.name)) {
        running = [...running, opts.arrivesLate];
      }
      listings.push(running.length);
      return [...running];
    },
    stop: (name: string): void => {
      if (opts.failStopOf === name) throw new Error(`docker stop ${name}: no such container`);
      stops.push(name);
      if (!(opts.stubborn ?? []).includes(name)) running = running.filter((entry) => entry.name !== name);
    },
  };
}

describe('quiesceWorkgroupsForBootMountChange', () => {
  it('a container in a changed workgroup is stopped', async () => {
    const runtime = fakeRuntime([container('nanoclaw-v2-a-1', 'wg-a')]);

    const scope = await quiesceWorkgroupsForBootMountChange(['wg-a'], { ...runtime, workgroupsTotal: 1 });

    expect(runtime.stops).toEqual(['nanoclaw-v2-a-1']);
    expect(scope).toEqual({
      workgroups: 1,
      containers: 1,
      stopped: 1,
      survivable: 0,
      unlabeled: 0,
      survivableSessionIds: [],
      mustStopSessionIds: ['nanoclaw-v2-a-1-session'],
    });
    expect(spawns).toEqual([]);
  });

  it('a container in an unchanged workgroup is counted survivable', async () => {
    const runtime = fakeRuntime([container('nanoclaw-v2-b-1', 'wg-b')]);

    const scope = await quiesceWorkgroupsForBootMountChange(['wg-a'], runtime);

    expect(scope.survivable).toBe(1);
    expect(scope.survivableSessionIds).toEqual(['nanoclaw-v2-b-1-session']);
    expect(scope.mustStopSessionIds).toEqual([]);
    // D1 STILL STOPS IT. This assertion is the D2 acceptance criterion: the
    // flip changes it to `expect(runtime.stops).toEqual([])` and
    // `stopped: 0`. Until then `survivable` is only a counterfactual.
    expect(runtime.stops).toEqual(['nanoclaw-v2-b-1']);
    expect(scope.stopped).toBe(scope.containers);
    expect(spawns).toEqual([]);
  });

  it('a container with no workgroup label is always stopped', async () => {
    // Divergence 7: on the first restart after the scope labels ship, every
    // live container looks like this. Unknown scope is stopped, fail-closed,
    // and it is never counted survivable.
    const runtime = fakeRuntime([container('nanoclaw-v2-legacy-1', null), container('nanoclaw-v2-b-1', 'wg-b')]);

    const scope = await quiesceWorkgroupsForBootMountChange([], { ...runtime, workgroupsTotal: 3 });

    expect(runtime.stops).toContain('nanoclaw-v2-legacy-1');
    expect(scope).toEqual({
      workgroups: 3,
      containers: 2,
      stopped: 2,
      survivable: 1,
      unlabeled: 1,
      survivableSessionIds: ['nanoclaw-v2-b-1-session'],
      mustStopSessionIds: ['nanoclaw-v2-legacy-1-session'],
    });
    expect(spawns).toEqual([]);
  });

  it('a runtime listing failure fails closed', async () => {
    const stops: string[] = [];

    await expect(
      quiesceWorkgroupsForBootMountChange(['wg-a'], {
        list: () => {
          throw new Error('Cannot prove install-scoped container absence: runtime listing failed');
        },
        stop: (name: string) => {
          stops.push(name);
        },
      }),
    ).rejects.toThrow(/prove install-scoped container absence/);

    // Nothing was stopped, nothing was logged as proved, and the caller never
    // reaches a reconcile: the rejection propagates out of startup.
    expect(stops).toEqual([]);
    expect(log.info).not.toHaveBeenCalledWith('Boot quiescence scope', expect.anything());
    expect(spawns).toEqual([]);
  });

  it('a stop that does not take fails closed', async () => {
    const runtime = fakeRuntime([container('nanoclaw-v2-a-1', 'wg-a')], { stubborn: ['nanoclaw-v2-a-1'] });

    await expect(quiesceWorkgroupsForBootMountChange(['wg-a'], runtime)).rejects.toThrow(
      /still running after boot quiescence/,
    );

    expect(runtime.stops).toEqual(['nanoclaw-v2-a-1']);
    expect(log.info).not.toHaveBeenCalledWith('Boot quiescence scope', expect.anything());
    expect(spawns).toEqual([]);
  });

  it('a container that appears between the two listings fails closed', async () => {
    // The proof is over the SECOND inventory, not over the first listing's
    // names. A newcomer holds the very mounts this boot is about to rewrite, so
    // intersecting it away would report quiescence with a live container.
    const runtime = fakeRuntime([container('nanoclaw-v2-a-1', 'wg-a')], {
      arrivesLate: container('nanoclaw-v2-newcomer-1', 'wg-a'),
    });

    await expect(quiesceWorkgroupsForBootMountChange(['wg-a'], runtime)).rejects.toThrow(
      /still running after boot quiescence: nanoclaw-v2-newcomer-1/,
    );

    expect(runtime.stops).toEqual(['nanoclaw-v2-a-1']);
    expect(log.info).not.toHaveBeenCalledWith('Boot quiescence scope', expect.anything());
    expect(spawns).toEqual([]);
  });

  it('a stop that throws fails closed', async () => {
    const runtime = fakeRuntime([container('nanoclaw-v2-a-1', 'wg-a'), container('nanoclaw-v2-b-1', 'wg-b')], {
      failStopOf: 'nanoclaw-v2-b-1',
    });

    await expect(quiesceWorkgroupsForBootMountChange(['wg-a', 'wg-b'], runtime)).rejects.toThrow(
      /prove install-scoped container absence: failed to stop nanoclaw-v2-b-1/,
    );

    expect(runtime.stops).toEqual(['nanoclaw-v2-a-1']);
    expect(log.info).not.toHaveBeenCalledWith('Boot quiescence scope', expect.anything());
    expect(spawns).toEqual([]);
  });

  it('a post-stop listing failure fails closed', async () => {
    // Docker going away AFTER the stops is not "none running" either. The
    // accountability note for those sessions was already written before this
    // door ran (src/main.ts), so the door has nothing to hand back — it just
    // has to refuse to report quiescence.
    const runtime = fakeRuntime([container('nanoclaw-v2-a-1', 'wg-a'), container('nanoclaw-v2-b-1', 'wg-b')], {
      failListCall: 2,
    });

    await expect(quiesceWorkgroupsForBootMountChange(['wg-a', 'wg-b'], runtime)).rejects.toThrow(
      /prove install-scoped container absence/,
    );

    expect(runtime.stops).toEqual(['nanoclaw-v2-a-1', 'nanoclaw-v2-b-1']);
    expect(log.info).not.toHaveBeenCalledWith('Boot quiescence scope', expect.anything());
    expect(spawns).toEqual([]);
  });

  it('the partition names the survivors seam-4 E and G will consume', async () => {
    // The counts are what an operator reads; the ids are what the later series
    // act on. They have to agree, and the partition has to be exact — every
    // container is on one side or the other.
    const runtime = fakeRuntime([
      container('nanoclaw-v2-a-1', 'wg-a'), // changed workgroup  → must stop
      container('nanoclaw-v2-b-1', 'wg-b'), // unchanged          → survivable
      container('nanoclaw-v2-c-1', 'wg-c'), // unchanged          → survivable
      container('nanoclaw-v2-legacy-1', null), // no workgroup    → must stop
      // A workgroup label but NO session label: adoption could never claim it,
      // so leaving it running under D2 would leak it. Fail closed.
      { name: 'nanoclaw-v2-nosession-1', workgroupId: 'wg-b', sessionId: null, groupId: 'g' },
    ]);

    const scope = await quiesceWorkgroupsForBootMountChange(['wg-a'], { ...runtime, workgroupsTotal: 4 });

    expect(scope.survivableSessionIds).toEqual(['nanoclaw-v2-b-1-session', 'nanoclaw-v2-c-1-session']);
    expect(scope.survivable).toBe(scope.survivableSessionIds.length);
    expect(scope.mustStopSessionIds).toEqual(['nanoclaw-v2-a-1-session', 'nanoclaw-v2-legacy-1-session']);
    // The session-less container is in must-stop and contributes no id, so the
    // two arrays are one short of `containers` by exactly that container.
    expect(scope.containers).toBe(5);
    expect(scope.survivableSessionIds.length + scope.mustStopSessionIds.length).toBe(scope.containers - 1);
    // …and it was stopped all the same.
    expect(runtime.stops).toContain('nanoclaw-v2-nosession-1');
    expect(spawns).toEqual([]);
  });

  it('the scope log carries every count', async () => {
    const runtime = fakeRuntime([
      container('nanoclaw-v2-a-1', 'wg-a'),
      container('nanoclaw-v2-b-1', 'wg-b'),
      container('nanoclaw-v2-legacy-1', null),
    ]);

    await quiesceWorkgroupsForBootMountChange(['wg-a', 'wg-c'], { ...runtime, workgroupsTotal: 5 });

    const scopeLines = (log.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (call) => call[0] === 'Boot quiescence scope',
    );
    expect(scopeLines).toHaveLength(1);
    // Plan §6's measurement shape in full: `changed` is only readable against
    // the total the predicates were asked about.
    expect(scopeLines[0][1]).toEqual({
      workgroups: 5,
      changed: 2,
      containers: 3,
      stopped: 3,
      survivable: 1,
      unlabeled: 1,
      mustStop: 2,
    });
    expect(spawns).toEqual([]);
  });
});
