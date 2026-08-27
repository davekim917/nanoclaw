import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `execFileAsync = promisify(execFile)` in the module under test — we hand
// execFile a promisify.custom implementation so promisify calls it directly
// with (file, args, opts) instead of appending a node-style callback. The
// mutable `execImpl` (via vi.hoisted, so it's safe to reference inside the
// hoisted vi.mock factory) is what each test configures.
const execState = vi.hoisted(() => ({
  impl: (_file: string, _args: string[]): Promise<{ stdout: string; stderr: string }> =>
    Promise.resolve({ stdout: '', stderr: '' }),
}));

vi.mock('child_process', () => {
  const execFile: unknown = () => {
    throw new Error('execFile called directly — expected promisify.custom path only');
  };
  (execFile as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = (file: string, args: string[]) =>
    execState.impl(file, args);
  return { execFile };
});

vi.mock('./log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./log.js')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const mockCheckDepsDrift = vi.fn();
vi.mock('./agent-runner-image-check.js', () => ({
  checkAgentRunnerDepsDrift: () => mockCheckDepsDrift(),
}));

import {
  MIN_RETRY_INTERVAL_MS,
  requestContainerRebuild,
  startContainerRebuildWatcher,
  stopContainerRebuildWatcher,
  _pendingRebuildForTest,
  _resetWatcherStateForTest,
  _setNotifierForTest,
} from './container-rebuild-watcher.js';

// Fixture shas. ORIGIN === HEAD by default (checkout is current with
// origin/main) so most tests only need to configure whether the *image*
// label is stale, without also exercising the head-covers-origin-main path.
const ORIGIN_SHA = 'origin0000000000000000000000000000000000';
const HEAD_SHA = ORIGIN_SHA;
const STALE_IMAGE_SHA = 'stale111111111111111111111111111111111';

interface World {
  fetchOk: boolean;
  originSha: string;
  headSha: string;
  imageLabel: string | null; // null => "no image / no label"
  // merge-base --is-ancestor A B succeeds (A is ancestor of B) when B is in this set.
  ancestorTrueFor: Set<string>;
  // git diff --name-only X Y -- container/ , keyed "X|Y"
  diffs: Record<string, string>;
  buildOk: boolean;
  buildCalls: number;
}

let world: World;

function freshWorld(): World {
  return {
    fetchOk: true,
    originSha: ORIGIN_SHA,
    headSha: HEAD_SHA,
    imageLabel: STALE_IMAGE_SHA,
    ancestorTrueFor: new Set(),
    // Default: container/ differs between the stale image and origin/main —
    // this is what makes checkStaleness() report stale so the default world
    // reaches the build step.
    diffs: { [`${STALE_IMAGE_SHA}|${ORIGIN_SHA}`]: 'container/agent-runner/package.json' },
    buildOk: true,
    buildCalls: 0,
  };
}

function installExecImpl(w: World): void {
  execState.impl = async (file: string, args: string[]) => {
    if (file === 'docker') {
      // imageCommitLabel(): inspect --format ... IMAGE_REF
      return { stdout: w.imageLabel ?? '<no value>', stderr: '' };
    }
    if (file === 'bash') {
      w.buildCalls++;
      if (w.buildOk) return { stdout: '', stderr: '' };
      throw new Error('build.sh exited 1: boom');
    }
    if (file === 'git') {
      const [sub, ...rest] = args;
      if (sub === 'pull') throw new Error('git pull must never be invoked by this module');
      if (sub === 'fetch') {
        if (!w.fetchOk) throw new Error('fetch failed: network unreachable');
        return { stdout: '', stderr: '' };
      }
      if (sub === 'rev-parse') {
        if (rest.includes('origin/main')) return { stdout: `${w.originSha}\n`, stderr: '' };
        if (rest.includes('HEAD')) return { stdout: `${w.headSha}\n`, stderr: '' };
      }
      if (sub === 'merge-base') {
        // ['merge-base', '--is-ancestor', A, B]
        const b = args[3];
        if (w.ancestorTrueFor.has(b)) return { stdout: '', stderr: '' };
        throw new Error('not an ancestor');
      }
      if (sub === 'diff') {
        // ['diff', '--name-only', X, Y, '--', 'container/']
        const [x, y] = [args[2], args[3]];
        return { stdout: w.diffs[`${x}|${y}`] ?? '', stderr: '' };
      }
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
}

let notified: string[];
const notifier = async (message: string): Promise<void> => {
  notified.push(message);
};

beforeEach(() => {
  _resetWatcherStateForTest();
  world = freshWorld();
  installExecImpl(world);
  notified = [];
  mockCheckDepsDrift.mockReset();
  mockCheckDepsDrift.mockResolvedValue({ ok: true, message: 'agent-runner deps in sync' });
  // Register the notifier directly (not via startContainerRebuildWatcher) so
  // these tests aren't racing that function's own async startup check —
  // the startup check itself is covered by the dedicated describe block below.
  _setNotifierForTest(notifier);
});

afterEach(() => {
  stopContainerRebuildWatcher();
});

describe('requestContainerRebuild', () => {
  it('coalesces concurrent refusals into a single rebuild', async () => {
    requestContainerRebuild('deps drift A');
    requestContainerRebuild('deps drift B');
    requestContainerRebuild('deps drift C');
    await _pendingRebuildForTest();

    expect(world.buildCalls).toBe(1);
  });

  it('does not block the caller — returns before the rebuild settles', () => {
    execState.impl = () => new Promise(() => {}); // never resolves
    requestContainerRebuild('deps drift');
    // If requestContainerRebuild awaited the rebuild internally, this
    // assertion would never run (the call above would hang).
    expect(_pendingRebuildForTest()).not.toBeNull();
  });

  it('never invokes git pull', async () => {
    requestContainerRebuild('deps drift');
    await _pendingRebuildForTest();
    // installExecImpl() throws on 'pull' — reaching here without a thrown
    // rejection is the proof. Also assert the rebuild actually completed ok.
    expect(world.buildCalls).toBe(1);
  });

  it('retries and notifies on failure, floors retries for MIN_RETRY_INTERVAL_MS, then retries again after', async () => {
    // Fake timers control Date.now() (which the retry floor reads) without a
    // real 10-minute sleep. None of the mocked exec calls use real timers, so
    // awaiting _pendingRebuildForTest() still settles normally under it.
    vi.useFakeTimers();
    try {
      world.buildOk = false;
      requestContainerRebuild('deps drift');
      await _pendingRebuildForTest();
      expect(world.buildCalls).toBe(1);
      expect(notified.some((m) => m.includes('Container rebuild failed'))).toBe(true);

      // Immediate retry within the cooldown: no new attempt, no new notify.
      notified = [];
      requestContainerRebuild('deps drift again');
      expect(_pendingRebuildForTest()).toBeNull();
      expect(world.buildCalls).toBe(1);
      expect(notified).toHaveLength(0);

      // Past the cooldown: retries.
      vi.advanceTimersByTime(MIN_RETRY_INTERVAL_MS + 1);
      requestContainerRebuild('deps drift once more');
      await _pendingRebuildForTest();
      expect(world.buildCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a successful rebuild resets the retry floor immediately', async () => {
    requestContainerRebuild('deps drift');
    await _pendingRebuildForTest();
    expect(world.buildCalls).toBe(1);
    expect(notified.some((m) => m.startsWith('✅'))).toBe(true);

    // No cooldown after success — the very next request retries right away.
    requestContainerRebuild('deps drift again');
    await _pendingRebuildForTest();
    expect(world.buildCalls).toBe(2);
  });

  it('does not rebuild, and says so, when the image already matches origin/main for container/', async () => {
    world.imageLabel = world.originSha; // image already at HEAD/origin
    requestContainerRebuild('agent-runner deps drift on foo');
    await _pendingRebuildForTest();

    expect(world.buildCalls).toBe(0);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('rebuilding will not fix this');
  });

  it('asks for a pull instead of building when the checkout is behind origin/main on container/', async () => {
    world.headSha = 'behind22222222222222222222222222222222';
    world.diffs[`${world.headSha}|${world.originSha}`] = 'container/agent-runner/bun.lock';
    requestContainerRebuild('deps drift');
    await _pendingRebuildForTest();

    expect(world.buildCalls).toBe(0);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('git pull --ff-only origin main');
  });

  it('suppresses a duplicate failure notification but still applies the retry floor', async () => {
    vi.useFakeTimers();
    try {
      world.buildOk = false;
      requestContainerRebuild('deps drift');
      await _pendingRebuildForTest();
      expect(notified).toHaveLength(1);

      vi.advanceTimersByTime(MIN_RETRY_INTERVAL_MS + 1);
      requestContainerRebuild('deps drift');
      await _pendingRebuildForTest();
      // Same failure detail both times -> second notify suppressed.
      expect(notified).toHaveLength(1);
      expect(world.buildCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Flush pending microtasks — enough for the checkAgentRunnerDepsDrift().then()
// chain in startContainerRebuildWatcher to run and (if it decided to) call
// requestContainerRebuild, without depending on real timers.
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('startContainerRebuildWatcher', () => {
  it('runs one startup check and requests a rebuild if the base image is already drifted', async () => {
    mockCheckDepsDrift.mockResolvedValue({ ok: false, message: 'agent-runner deps drift: x != y' });
    startContainerRebuildWatcher(notifier);
    await flushMicrotasks();
    expect(_pendingRebuildForTest()).not.toBeNull();
    await _pendingRebuildForTest();
    expect(world.buildCalls).toBe(1);
  });

  it('is idempotent — a second start call is a no-op', () => {
    startContainerRebuildWatcher(notifier);
    startContainerRebuildWatcher(notifier);
    expect(mockCheckDepsDrift).toHaveBeenCalledTimes(1);
  });

  it('does nothing on startup when the base image is already in sync', async () => {
    mockCheckDepsDrift.mockResolvedValue({ ok: true, message: 'agent-runner deps in sync' });
    startContainerRebuildWatcher(notifier);
    await flushMicrotasks();
    expect(mockCheckDepsDrift).toHaveBeenCalled();
    expect(_pendingRebuildForTest()).toBeNull();
    expect(world.buildCalls).toBe(0);
  });
});
