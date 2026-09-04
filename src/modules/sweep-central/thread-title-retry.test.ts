/**
 * F-4.3b (docs/specs/upstream-host-sweep-seam/plan.md §8, S2-PR4) — half of
 * "session-title and thread-title sweeps keep their caps, cooldowns and
 * backoffs". Ported from src/topic-title.test.ts (that file's own full
 * suite is untouched — this family PR only moved the tick:housekeeping
 * registration wrapper (T16), not topic-title.ts's own code).
 *
 * Kept in its own file, not central.test.ts: needs a full
 * `vi.mock('../../llm.js', ...)`, which conflicts with
 * session-title-sweep.test.ts's need for the REAL llm.js reset helpers —
 * `vi.mock` is hoisted per FILE, not per `describe` block.
 *
 * Codex review finding (efb8350a..838d84f6, accepted): the cases above call
 * `retryPendingThreadTitles` DIRECTLY, proving topic-title.ts's own behavior
 * but not that the REGISTERED T16 duty actually calls it. The
 * "the registered thread-title-retry duty" describe below closes that gap:
 * it fetches T16 from the same registry accessor R-7 uses
 * (`_listSweepRegistrationsForTesting`) and invokes its `run(ctx)`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { insertThreadTitleClaim, recordThreadTitleAttemptFailure } from '../../db/thread-titles.js';
import { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY, type SweepTickContext } from '../../host-sweep.js';
import { log } from '../../log.js';

// Hermeticity (brief-common.md HARD RULE): the "registered T16 duty" describe
// below runs a real duty body via the registry, not just a direct function
// call, and now pulls in the full host-sweep.js import graph. A tripwire, not
// a functional mock — it records the call and then throws, so a caller that
// swallows the throw still fails the test via the recorded array.
const h = vi.hoisted(() => ({ spawns: [] as string[] }));
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`thread-title-retry.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

vi.mock('../../llm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../llm.js')>()),
  callHaiku: vi.fn(async () => 'Rollout fix'),
}));
// Spy on retryPendingThreadTitles while keeping it real by default (a plain
// `vi.fn(real.impl)`, not a `vi.spyOn`), so the existing direct-call cases
// below keep exercising real behavior — the registered-duty describe below
// only overrides the implementation `.mockImplementationOnce()`.
vi.mock('../../topic-title.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../topic-title.js')>();
  return { ...real, retryPendingThreadTitles: vi.fn(real.retryPendingThreadTitles) };
});

import { retryPendingThreadTitles } from '../../topic-title.js';
// Side-effect import — registers this family's duties (via
// `registerSweepDutySource`) so `_listSweepRegistrationsForTesting()` below
// can find T16 by name.
import './index.js';

const THREAD_ID = 'discord:11111111111111111:22222222222222222:33333333333333333';
const NOW = '2026-08-31T12:00:00.000Z';

// Hermeticity (brief-common.md HARD RULE): retryPendingThreadTitles calls
// attemptThreadTitle, which PATCHes Discord over `fetch` when a bot token is
// configured. Explicitly clear the token (never inherit a real one from this
// shell) and stub fetch so a missing clear can't silently reach the network.
let originalToken: string | undefined;

beforeEach(() => {
  // Truncate, never reassign: the tripwire factory closed over THIS array.
  h.spawns.length = 0;
  runMigrations(initTestDb());
  originalToken = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('thread-title-retry.test: real fetch attempted');
    }),
  );
});

afterEach(() => {
  closeDb();
  // NOT vi.restoreAllMocks(): the `vi.mock('../../topic-title.js',
  // importOriginal)` above wraps the real `retryPendingThreadTitles` as
  // `vi.fn(real.impl)`, not a `vi.spyOn` — restoreAllMocks() would clear that
  // wrapping's implementation for the rest of this file (a bare vi.fn() has
  // no "original" to restore to), silently turning every later call-through
  // into a no-op and breaking the direct-call cases above. Any test that
  // uses vi.spyOn restores it itself.
  vi.unstubAllGlobals();
  if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = originalToken;
});

describe('F-4.3b — thread-title retry keeps its batch cap, attempt cap and retry window', () => {
  it('excludes rows at the 5-attempt cap', async () => {
    insertThreadTitleClaim(THREAD_ID, 'discord', 'opener', NOW);
    for (let i = 0; i < 5; i++) recordThreadTitleAttemptFailure(THREAD_ID);
    expect(await retryPendingThreadTitles(NOW)).toEqual({ attempted: 0, titled: 0 });
  });

  it('excludes rows older than the 24h retry window', async () => {
    const staleId = `${THREAD_ID}:stale`;
    insertThreadTitleClaim(staleId, 'discord', 'opener', '2026-08-29T12:00:00.000Z'); // 48h before NOW
    recordThreadTitleAttemptFailure(staleId);
    expect(await retryPendingThreadTitles(NOW)).toEqual({ attempted: 0, titled: 0 });
  });

  it('caps at 1 retry per call even with more eligible rows (RETRY_BATCH_CAP)', async () => {
    for (let i = 1; i <= 5; i++) {
      insertThreadTitleClaim(`discord:g:c:${i}`, 'discord', `opener ${i}`, NOW);
      recordThreadTitleAttemptFailure(`discord:g:c:${i}`);
    }
    const result = await retryPendingThreadTitles(NOW);
    expect(result.attempted).toBe(1);
  });
});

// ── Codex finding — the registered T16 duty must call retryPendingThreadTitles

describe('the registered thread-title-retry duty calls retryPendingThreadTitles', () => {
  const fakeTickCtx: SweepTickContext = { now: Date.now(), sessions: [], activeContainerSessionIds: new Set() };

  function t16Duty() {
    const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.T16);
    if (!duty) throw new Error('duty not registered: thread-title-retry');
    return duty;
  }

  /** T16's `run` is `void import(...).then(...)` — fire-and-forget, returns
   *  before the dynamic import settles, so poll rather than await `run()`. */
  async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('calls retryPendingThreadTitles with no arguments', async () => {
    const spy = vi.mocked(retryPendingThreadTitles);
    spy.mockClear();
    spy.mockImplementationOnce(async () => ({ attempted: 0, titled: 0 }));

    t16Duty().run(fakeTickCtx);
    await waitUntil(() => spy.mock.calls.length > 0);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();
    expect(h.spawns).toEqual([]);
  });

  it("a rejection is logged with the wrapper's own string", async () => {
    const spy = vi.mocked(retryPendingThreadTitles);
    spy.mockClear();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      spy.mockImplementationOnce(async () => {
        throw new Error('thread-title retry boom');
      });

      t16Duty().run(fakeTickCtx);
      await waitUntil(() => warn.mock.calls.length > 0);

      expect(warn).toHaveBeenCalledWith(
        'thread-title retry sweep failed',
        expect.objectContaining({ err: expect.any(Error) }),
      );
    } finally {
      warn.mockRestore();
    }
    expect(h.spawns).toEqual([]);
  });

  it('the child_process tripwire bites when a seam mock is removed', () => {
    const record: string[] = [];
    const tripwire = childProcessTripwire(record);
    expect(() => tripwire.execSync!('git pull')).toThrow(/real process spawn attempted/);
    expect(record).toEqual(['execSync']);
  });
});
