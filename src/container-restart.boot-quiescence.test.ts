/**
 * The boot door for mount changes (seam 4 D1, plan §7.D).
 *
 * The runtime listing is faked, because the property under test is the
 * PARTITION and the PROOF, not docker's output format: which containers land
 * in the stop set, that an unlabeled container can never escape it, and that
 * both a listing that cannot be taken and a stop that does not take end the
 * boot rather than letting a reconcile run under a live container.
 *
 * D1 stops everything and only counts `survivable`. The D2 PR flips the
 * "unchanged workgroup" case from stopped to surviving, and that flip is D2's
 * acceptance criterion.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

interface FakeContainer {
  name: string;
  workgroupId: string | null;
  sessionId: string | null;
  groupId: string | null;
}

/** Containers the fake runtime reports as running. Mutated by `stopContainer`. */
let running: FakeContainer[] = [];
/** Names whose stop silently does not take (the container keeps running). */
let stopIsInert = new Set<string>();
/** Names whose stop throws. */
let stopThrows = new Set<string>();
let listThrows = false;
const listCalls: number[] = [];
const stopped: string[] = [];

vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  listInstallContainersWithScope: () => {
    listCalls.push(running.length);
    if (listThrows) {
      throw new Error('Cannot prove install-scoped container absence: runtime listing failed');
    }
    return running.map((container) => ({ ...container }));
  },
  stopContainer: (name: string) => {
    stopped.push(name);
    if (stopThrows.has(name)) throw new Error(`docker stop failed: ${name}`);
    if (stopIsInert.has(name)) return;
    running = running.filter((container) => container.name !== name);
  },
}));

import { quiesceWorkgroupsForBootMountChange } from './container-restart.js';
import { log } from './log.js';

function container(name: string, workgroupId: string | null): FakeContainer {
  return { name, workgroupId, sessionId: `sess-${name}`, groupId: `ag-${name}` };
}

function scopeLogCalls(): Array<Record<string, unknown>> {
  return vi
    .mocked(log.info)
    .mock.calls.filter((call) => call[0] === 'Boot quiescence scope')
    .map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  running = [];
  stopIsInert = new Set();
  stopThrows = new Set();
  listThrows = false;
  listCalls.length = 0;
  stopped.length = 0;
});

describe('quiesceWorkgroupsForBootMountChange', () => {
  it('a container in a changed workgroup is stopped', async () => {
    running = [container('nanoclaw-v2-a', 'wg-changed')];

    const scope = await quiesceWorkgroupsForBootMountChange(['wg-changed']);

    expect(stopped).toEqual(['nanoclaw-v2-a']);
    expect(scope).toEqual({ containers: 1, stopped: 1, survivable: 0, unlabeled: 0 });
  });

  it('a container in an unchanged workgroup is counted survivable', async () => {
    running = [container('nanoclaw-v2-a', 'wg-changed'), container('nanoclaw-v2-b', 'wg-quiet')];

    const scope = await quiesceWorkgroupsForBootMountChange(['wg-changed']);

    expect(scope.survivable).toBe(1);
    // D1: measured, not honoured. The survivor is still stopped, exactly as
    // the fleet-wide cleanup stopped it. D2 flips this line.
    expect(stopped).toEqual(['nanoclaw-v2-a', 'nanoclaw-v2-b']);
    expect(scope).toEqual({ containers: 2, stopped: 2, survivable: 1, unlabeled: 0 });
  });

  it('a container with no workgroup label is always stopped', async () => {
    // Every container is in this state on the first restart after the scope
    // labels ship: unknown scope, so it can never be assumed survivable.
    running = [container('nanoclaw-v2-old', null), container('nanoclaw-v2-b', 'wg-quiet')];

    const scope = await quiesceWorkgroupsForBootMountChange([]);

    expect(stopped).toContain('nanoclaw-v2-old');
    expect(scope.unlabeled).toBe(1);
    expect(scope.survivable).toBe(1);
  });

  it('a runtime listing failure fails closed', async () => {
    running = [container('nanoclaw-v2-a', 'wg-changed')];
    listThrows = true;

    await expect(quiesceWorkgroupsForBootMountChange(['wg-changed'])).rejects.toThrow(
      /Cannot prove install-scoped container absence/,
    );
    expect(stopped).toEqual([]);
    expect(scopeLogCalls()).toEqual([]);
  });

  it('a stop that does not take fails closed', async () => {
    running = [container('nanoclaw-v2-a', 'wg-changed')];
    stopIsInert = new Set(['nanoclaw-v2-a']);

    await expect(quiesceWorkgroupsForBootMountChange(['wg-changed'])).rejects.toThrow(
      /Boot mount quiescence incomplete: containers still running after stop: nanoclaw-v2-a/,
    );
    expect(scopeLogCalls()).toEqual([]);
  });

  it('a stop that throws fails closed', async () => {
    running = [container('nanoclaw-v2-a', 'wg-changed')];
    stopThrows = new Set(['nanoclaw-v2-a']);

    await expect(quiesceWorkgroupsForBootMountChange(['wg-changed'])).rejects.toThrow(
      /Cannot prove boot mount quiescence: failed to stop nanoclaw-v2-a/,
    );
    // The post-stop proof is never reached — one listing, not two.
    expect(listCalls).toHaveLength(1);
  });

  it('the scope log carries every count', async () => {
    running = [
      container('nanoclaw-v2-a', 'wg-changed'),
      container('nanoclaw-v2-b', 'wg-quiet'),
      container('nanoclaw-v2-c', 'wg-quiet'),
      container('nanoclaw-v2-old', null),
    ];

    await quiesceWorkgroupsForBootMountChange(['wg-changed', 'wg-also-changed']);

    expect(scopeLogCalls()).toEqual([{ containers: 4, stopped: 4, survivable: 2, unlabeled: 1, changed: 2 }]);
  });

  it('an install with no containers stops nothing and still logs its scope', async () => {
    const scope = await quiesceWorkgroupsForBootMountChange(['wg-changed']);

    expect(stopped).toEqual([]);
    expect(scope).toEqual({ containers: 0, stopped: 0, survivable: 0, unlabeled: 0 });
    expect(scopeLogCalls()).toEqual([{ containers: 0, stopped: 0, survivable: 0, unlabeled: 0, changed: 1 }]);
  });
});
