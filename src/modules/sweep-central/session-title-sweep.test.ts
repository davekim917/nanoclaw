/**
 * F-4.3a (docs/specs/upstream-host-sweep-seam/plan.md §8, S2-PR4) — half of
 * "session-title and thread-title sweeps keep their caps, cooldowns and
 * backoffs". Ported from src/dashboard/session-title-sweep.test.ts (that
 * file's own full suite is untouched — this family PR only moved the
 * tick:housekeeping registration wrapper (T15), not the dashboard module's
 * own code, so its behavior is re-proven here as the acceptance evidence for
 * the moved wrapper's dependency).
 *
 * Kept in its own file, not central.test.ts: this fixture needs the REAL
 * src/llm.js (for its credential-rotation reset helpers), which conflicts
 * with thread-title-retry.test.ts's full `vi.mock('../../llm.js', ...)` —
 * `vi.mock` is hoisted per FILE, not per `describe` block.
 *
 * Codex review finding (efb8350a..838d84f6, accepted): the cases above call
 * `runSessionTitleSweep` DIRECTLY, proving the dashboard module's own
 * behavior but not that the REGISTERED T15 duty actually calls it. The
 * "the registered session-title-sweep duty" describe below closes that gap:
 * it fetches T15 from the same registry accessor R-7 uses
 * (`_listSweepRegistrationsForTesting`) and invokes its `run(ctx)`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY, type SweepTickContext } from '../../host-sweep.js';
import {
  __resetCallHaikuSlotCacheForTest,
  __resetCredentialRotationGateForTest,
  __setCredentialRotationGateMinIntervalForTest,
} from '../../llm.js';
import { log } from '../../log.js';
import {
  CONCURRENCY_CAP,
  COOLDOWN_HOURS,
  REFRESH_MIN_NEW_MESSAGES,
  _resetCooldownForTest,
  _resetTitleBackendForTest,
  runSessionTitleSweep,
  setTitleBackendForTest,
} from '../../dashboard/session-title-sweep.js';
// Side-effect import — registers this family's duties (via
// `registerSweepDutySource`) so `_listSweepRegistrationsForTesting()` below
// can find T15 by name.
import './index.js';

// `import './index.js'` above pulls in the full src/host-sweep.js graph
// (needed for `_listSweepRegistrationsForTesting`), which transitively
// imports src/message-archive.ts — that module reads `DATA_DIR` at ITS OWN
// top level (`const ARCHIVE_PATH = path.join(DATA_DIR, 'archive.db')`), i.e.
// during this file's import phase, before any later `let` in this module
// would have run. A plain `let TMP_DIR` hits the temporal dead zone the
// moment that happens. `vi.hoisted()` (same pattern as
// src/host-sweep-registry.test.ts's `h`) runs before that import chain, so
// the getter always has something to return.
const h = vi.hoisted(() => ({ tmpDir: '', spawns: [] as string[] }));

// Hermeticity (brief-common.md HARD RULE): the "registered T15 duty" describe
// below runs a real duty body via the registry, not just a direct function
// call, and now pulls in the full host-sweep.js import graph. A tripwire, not
// a functional mock — it records the call and then throws, so a caller that
// swallows the throw still fails the test via the recorded array.
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`session-title-sweep.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

// importOriginal, not a full replacement: importing the host-sweep.js graph
// (via `./index.js` above) transitively needs config.js's OTHER exports too
// (e.g. modules/scheduling/host-script.ts reads TASK_SCRIPT_TIMEOUT_MS at its
// own top level) — a bare `{ get DATA_DIR() {...} }}` leaves every other
// config export undefined and crashes that unrelated import.
vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get DATA_DIR() {
      return h.tmpDir;
    },
  };
});
// config.ts's own top-level code reads ONECLI_API_KEY and other secrets
// straight off the real .env file via readEnvFile() — with the config.js mock
// above now using importOriginal (needed for its OTHER exports), config.ts's
// real body executes for real, so this file must keep BOTH env.js exports
// safely stubbed, never real, to avoid ever loading actual on-disk secrets
// into this process. Spreading importOriginal below is still safe: env.ts has
// no import-time side effects (its functions only touch disk when CALLED),
// and both of its exports are explicitly overridden immediately after the
// spread, so they always resolve to the stub, never the real implementation.
vi.mock('../../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../env.js')>()),
  readEnvFile: vi.fn(() => ({})),
  readEnvFileMatching: vi.fn(() => ({})),
}));
// Spy on runSessionTitleSweep while keeping it real by default (a plain
// `vi.fn(real.impl)`, not a `vi.spyOn`), so the existing direct-call cases in
// this file keep exercising real behavior — the registered-duty describe
// below only overrides the implementation `.mockImplementationOnce()`.
vi.mock('../../dashboard/session-title-sweep.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../dashboard/session-title-sweep.js')>();
  return { ...real, runSessionTitleSweep: vi.fn(real.runSessionTitleSweep) };
});

function now(): string {
  return new Date().toISOString();
}

function seedSession(
  id: string,
  agentGroupId: string,
  opts: { title?: string | null; title_generated_at?: string | null; title_basis_seq?: number | null } = {},
): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at) VALUES (?, ?, NULL, ?, 'active', ?)",
    )
    .run(id, agentGroupId, `system:tasks:${id}`, now());
  if (opts.title !== undefined || opts.title_generated_at !== undefined || opts.title_basis_seq !== undefined) {
    getDb()
      .prepare(`UPDATE sessions SET title = ?, title_generated_at = ?, title_basis_seq = ? WHERE id = ?`)
      .run(opts.title ?? null, opts.title_generated_at ?? null, opts.title_basis_seq ?? null, id);
  }
}

function writeInboundMessages(agentGroupId: string, sessionId: string, seqAndContent: [number, string][]): void {
  const dir = path.join(h.tmpDir, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'inbound.db'));
  db.exec(
    `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, content TEXT);`,
  );
  for (const [seq, content] of seqAndContent) {
    db.prepare(`INSERT INTO messages_in VALUES (?, ?, 'chat', ?, 'pending', ?)`).run(`m-${seq}`, seq, now(), content);
  }
  db.close();
}

beforeEach(() => {
  h.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-central-'));
  // Truncate, never reassign: the tripwire factory closed over THIS array.
  h.spawns.length = 0;
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'ag-1', folder: 'ag-1', agent_provider: null, created_at: now() });
  __resetCallHaikuSlotCacheForTest();
  __resetCredentialRotationGateForTest();
  __setCredentialRotationGateMinIntervalForTest(0);
});

afterEach(() => {
  closeDb();
  _resetTitleBackendForTest();
  _resetCooldownForTest();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
  // NOT vi.restoreAllMocks(): the `vi.mock('../../dashboard/session-title-sweep.js',
  // importOriginal)` above wraps the real `runSessionTitleSweep` as
  // `vi.fn(real.impl)`, not a `vi.spyOn` — restoreAllMocks() would clear that
  // wrapping's implementation for the rest of this file (a bare vi.fn() has
  // no "original" to restore to), silently turning every later call-through
  // into a no-op and breaking the direct-call cases above. Any test that
  // uses vi.spyOn restores it itself.
  __resetCallHaikuSlotCacheForTest();
  __resetCredentialRotationGateForTest();
});

describe('F-4.3a — session-title sweep keeps its cap, cooldown and new-message threshold', () => {
  it('keeps CONCURRENCY_CAP=3, COOLDOWN_HOURS=1 and REFRESH_MIN_NEW_MESSAGES=10', () => {
    expect(CONCURRENCY_CAP).toBe(3);
    expect(COOLDOWN_HOURS).toBe(1);
    expect(REFRESH_MIN_NEW_MESSAGES).toBe(10);
  });

  it('skips a session with a recent title (<1h cooldown)', async () => {
    seedSession('sess-recent', 'ag-1', {
      title: 'existing',
      title_generated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      title_basis_seq: 2,
    });
    writeInboundMessages('ag-1', 'sess-recent', [[10, '{"text":"more chat"}']]);
    const backend = vi.fn(async () => 'WOULD REGENERATE');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it('does NOT refresh when cooldown passed but <10 new messages, and DOES when ≥10', async () => {
    seedSession('sess-quiet', 'ag-1', {
      title: 'old title',
      title_generated_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      title_basis_seq: 50,
    });
    writeInboundMessages('ag-1', 'sess-quiet', [[54, '{"text":"hi"}']]); // 4 past basis_seq
    const quietBackend = vi.fn(async () => 'newer title');
    setTitleBackendForTest(quietBackend);
    const quietResult = await runSessionTitleSweep();
    expect(quietResult.generated).toBe(0);
    expect(quietBackend).not.toHaveBeenCalled();

    seedSession('sess-busy', 'ag-1', {
      title: 'old title',
      title_generated_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      title_basis_seq: 10,
    });
    writeInboundMessages(
      'ag-1',
      'sess-busy',
      Array.from({ length: 12 }, (_, i) => [10 + i + 1, JSON.stringify({ text: `msg ${i}` })]) as [number, string][],
    );
    setTitleBackendForTest(async () => 'refreshed title');
    const busyResult = await runSessionTitleSweep();
    expect(busyResult.generated).toBe(1);
    const row = getDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-busy') as { title: string };
    expect(row.title).toBe('refreshed title');
  });

  it('honors the concurrency cap of 3', async () => {
    for (let i = 1; i <= 5; i++) {
      seedSession(`sess-c-${i}`, 'ag-1');
      writeInboundMessages('ag-1', `sess-c-${i}`, [[2, '{"text":"x"}']]);
    }
    let inFlight = 0;
    let peak = 0;
    setTitleBackendForTest(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return 'parallel title';
    });

    const result = await runSessionTitleSweep();
    expect(peak).toBeLessThanOrEqual(CONCURRENCY_CAP);
    expect(result.generated).toBe(CONCURRENCY_CAP);
  });

  it('a failed generation backs off for 15 minutes: stamped, then not retried before it', async () => {
    seedSession('sess-fail', 'ag-1');
    writeInboundMessages('ag-1', 'sess-fail', [[2, '{"text":"x"}']]);
    setTitleBackendForTest(async () => {
      throw new Error('boom');
    });

    const first = await runSessionTitleSweep();
    expect(first.generated).toBe(0);
    expect(first.skipped).toBe(1);

    const row = getDb().prepare('SELECT title_generated_at FROM sessions WHERE id = ?').get('sess-fail') as {
      title_generated_at: string | null;
    };
    expect(row.title_generated_at).toBeTruthy();

    const backendSecond = vi.fn(async () => 'should not run');
    setTitleBackendForTest(backendSecond);
    const second = await runSessionTitleSweep();
    expect(second.generated).toBe(0);
    expect(backendSecond).not.toHaveBeenCalled();
  });
});

// ── Codex finding — the registered T15 duty must call runSessionTitleSweep ──

describe('the registered session-title-sweep duty calls runSessionTitleSweep', () => {
  const fakeTickCtx: SweepTickContext = { now: Date.now(), sessions: [], activeContainerSessionIds: new Set() };

  function t15Duty() {
    const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.T15);
    if (!duty) throw new Error('duty not registered: session-title-sweep');
    return duty;
  }

  /** T15's `run` is `void import(...).then(...)` — fire-and-forget, returns
   *  before the dynamic import settles, so poll rather than await `run()`. */
  async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('calls runSessionTitleSweep with no arguments', async () => {
    const spy = vi.mocked(runSessionTitleSweep);
    spy.mockClear();
    spy.mockImplementationOnce(async () => ({ generated: 0, skipped: 0 }));

    void t15Duty().run(fakeTickCtx);
    await waitUntil(() => spy.mock.calls.length > 0);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();
    expect(h.spawns).toEqual([]);
  });

  it("a rejection is logged with the wrapper's own string", async () => {
    const spy = vi.mocked(runSessionTitleSweep);
    spy.mockClear();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      spy.mockImplementationOnce(async () => {
        throw new Error('title sweep boom');
      });

      void t15Duty().run(fakeTickCtx);
      await waitUntil(() => warn.mock.calls.length > 0);

      expect(warn).toHaveBeenCalledWith(
        'session-title sweep failed',
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
