/**
 * Unit tests for the watchdog decision function and outbound-DB helper.
 * The decideTaskAction tests are pure (no DB required).
 * The pendingTerminalSpawnOutboundSeenAt tests use in-memory SQLite via mocked path resolution.
 */
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, afterEach, vi } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../../test-hermeticity.js';
import { decideTaskAction } from './watchdog.js';
import type { Task } from './db/tasks.js';
import * as mailboxIndex from '../mailbox/index.js';

// DATA_DIR is redirected at a per-run temp root. The read-only seam resolves
// `<DATA_DIR>/v2-sessions/<agent group>/<session>/outbound.db` and refuses
// anything that resolves elsewhere, so the fixtures below have to live where a
// real session does — but "where a real session does" must not be the running
// install's own data tree, which these tests create in and recursively delete
// from. Same redirect host-sweep.test.ts and container-restart.test.ts use.
const testDataDir = vi.hoisted(() => {
  // `vi.hoisted` runs before this file's own imports, so the temp root has to
  // be built with `require` — the established shape in the two suites above.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'watchdog-data-')) };
});
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  get DATA_DIR() {
    return testDataDir.dir;
  },
}));

// This file mocks or redirects every seam it touches, so it holds itself to the
// strict tripwire rather than the repo's `warn` default (issue #305). The one
// real escape it needs is the lock-holding child process below, declared by
// name so the exemption is visible.
enforceHermeticity();
beforeAll(() => {
  allowSubprocess([path.basename(process.execPath)]);
});
afterAll(() => {
  fs.rmSync(testDataDir.dir, { recursive: true, force: true });
});

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-1',
    idempotency_key: 'idem-1',
    parent_session_id: 'parent-sess',
    parent_agent_group_id: 'parent-ag',
    parent_messaging_group_id: null,
    child_session_id: null,
    status: 'running',
    task_content: '{}',
    request_hash: 'hash',
    deadline: null,
    parent_platform_message_id: null,
    child_platform_thread_id: null,
    child_messaging_group_id: null,
    admitted_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
    started_at: new Date(BASE - 4 * 60 * 1000).toISOString(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_progress_at: new Date(BASE - 2 * 60 * 1000).toISOString(),
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'headless',
    needs_input: 0,
    steer_question: null,
    archived_at: null,
    created_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const DEFAULT_ARGS = {
  now: BASE,
  childContainerStatus: null as 'running' | 'stopped' | null,
  terminalOutboundSeenAt: null as string | null,
  noProgressTimeoutSec: 1800,
  spawnDeadlineSec: 300,
  drainGraceSec: 120,
};

// ─── C1: decideTaskAction ─────────────────────────────────────────────────────

describe('decideTaskAction', () => {
  // ASSERT C20: deadline check runs FIRST, overrides drain-first
  it('test_deadline_overrides_drain: returns fail-deadline even when drain is active', () => {
    const task = baseTask({
      deadline: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      terminalOutboundSeenAt: new Date(BASE).toISOString(), // drain active right now
    });
    expect(result.action).toBe('fail-deadline');
  });

  it('returns ok when deadline is in the future', () => {
    const task = baseTask({
      deadline: new Date(BASE + 60 * 60 * 1000).toISOString(), // 1 hour from now
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  // ASSERT: spawn deadline applies only when status='pending' AND admitted_at IS NOT NULL AND started_at IS NULL
  it('returns fail-spawn-deadline for pending task past spawn window', () => {
    const task = baseTask({
      status: 'pending',
      started_at: null,
      last_progress_at: null,
      admitted_at: new Date(BASE - 6 * 60 * 1000).toISOString(), // 6 min ago, beyond 5 min spawn deadline
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('fail-spawn-deadline');
  });

  it('returns ok for pending task within spawn window', () => {
    const task = baseTask({
      status: 'pending',
      started_at: null,
      last_progress_at: null,
      admitted_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // 2 min ago, within 5 min spawn deadline
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  it('does NOT trigger spawn deadline when started_at is set (already started)', () => {
    const task = baseTask({
      status: 'pending',
      started_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // already started
      admitted_at: new Date(BASE - 10 * 60 * 1000).toISOString(), // old admission
    });
    // Not in spawn-deadline branch (started_at is set); last_progress_at is 2 min ago which is within 1800s
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  // ASSERT M24: drain-first grace measured from terminalOutboundSeenAt, NOT last_progress_at
  it('test_drain_grace_starts_from_terminal_seen_at: returns ok when drain is recent even with stale progress', () => {
    const task = baseTask({
      last_progress_at: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago — well past no-progress timeout
      child_session_id: 'child-sess',
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'running',
      terminalOutboundSeenAt: new Date(BASE - 30 * 1000).toISOString(), // 30s ago — within 120s grace
      drainGraceSec: 120,
    });
    expect(result.action).toBe('ok');
  });

  // ASSERT: drain-first allows up to drainGraceSec; beyond that, falls through
  it('test_drain_grace_expired: returns fail-no-progress when drain grace has elapsed', () => {
    const task = baseTask({
      last_progress_at: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago
      child_session_id: 'child-sess',
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'running',
      terminalOutboundSeenAt: new Date(BASE - 200 * 1000).toISOString(), // 200s ago — beyond 120s grace
      drainGraceSec: 120,
    });
    expect(result.action).toBe('fail-no-progress');
  });

  it('drain-first is NOT active when terminalOutboundSeenAt is null', () => {
    const task = baseTask({
      last_progress_at: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago — triggers no-progress
      child_session_id: 'child-sess',
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      terminalOutboundSeenAt: null,
      noProgressTimeoutSec: 1800,
    });
    expect(result.action).toBe('fail-no-progress');
  });

  // ASSERT C21: triple fallback last_signal = last_progress_at OR started_at OR admitted_at
  it('test_last_signal_falls_back_to_started_at: no reap when started_at is recent', () => {
    const task = baseTask({
      status: 'running',
      last_progress_at: null,
      started_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // 2 min ago — within 1800s timeout
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  it('test_last_signal_falls_back_to_admitted_at: uses admitted_at when both others are null', () => {
    const task = baseTask({
      status: 'running',
      last_progress_at: null,
      started_at: null,
      admitted_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // 2 min ago — within 1800s timeout
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  it('triggers no-progress using admitted_at fallback when all others are null and old', () => {
    const task = baseTask({
      status: 'running',
      last_progress_at: null,
      started_at: null,
      admitted_at: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago — past no-progress timeout
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task, noProgressTimeoutSec: 1800 });
    expect(result.action).toBe('fail-no-progress');
  });

  // ASSERT C21 plan test: pending task with admitted_at falls into spawn-deadline path first
  it('test_no_progress_with_admitted_at_fallback: pending task hits spawn deadline first', () => {
    const task = baseTask({
      status: 'pending',
      started_at: null,
      last_progress_at: null,
      admitted_at: new Date(BASE - 31 * 60 * 1000).toISOString(), // 31 min ago
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      noProgressTimeoutSec: 1800,
      spawnDeadlineSec: 300,
    });
    // spawn deadline check fires first (pending + admitted + no started_at)
    expect(result.action).toBe('fail-spawn-deadline');
  });

  it('test_no_progress_running_with_started_at: running task hits no-progress when started_at is old', () => {
    const task = baseTask({
      status: 'running',
      started_at: new Date(BASE - 31 * 60 * 1000).toISOString(), // 31 min ago
      last_progress_at: null,
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      noProgressTimeoutSec: 1800,
    });
    expect(result.action).toBe('fail-no-progress');
  });

  // ASSERT: container-exit branch only when child_session_id IS NOT NULL
  it('test_container_exit_only_when_child_exists: no fail-container-exit when child_session_id is null', () => {
    const task = baseTask({
      child_session_id: null,
      last_progress_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // recent progress
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'stopped',
    });
    // child_session_id is null → container exit branch doesn't fire
    expect(result.action).toBe('ok');
  });

  it('returns fail-container-exit when child exists and container stopped', () => {
    const task = baseTask({
      child_session_id: 'child-sess',
      last_progress_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // recent progress
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'stopped',
    });
    expect(result.action).toBe('fail-container-exit');
  });

  it('returns ok when child exists and container is running', () => {
    const task = baseTask({
      child_session_id: 'child-sess',
      last_progress_at: new Date(BASE - 2 * 60 * 1000).toISOString(),
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'running',
    });
    expect(result.action).toBe('ok');
  });

  it('returns ok when everything is healthy', () => {
    const task = baseTask();
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });
});

// ─── C2: pendingTerminalSpawnOutboundSeenAt ────────────────────────────────
// Real on-disk SQLite DBs under a session tree rooted at the redirected
// DATA_DIR above. The helper reads through the mailbox module's read-only seam
// (PR 6), which resolves `<DATA_DIR>/v2-sessions/<agent group>/<session>/
// outbound.db` and refuses anything that resolves elsewhere — so the fixture
// has to live where a real session does, and a path mock would no longer be
// exercising the real resolution at all. Redirecting DATA_DIR keeps that true
// while putting the tree in a temp root. Agent-group ids carry the pid so
// parallel suites cannot collide.

const TEST_ROOT = path.join(testDataDir.dir, 'v2-sessions');
const TEST_AG_PREFIX = `wd-${process.pid}-`;
const tmpSessions: string[] = [];

function makeTmpOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const dir = path.join(TEST_ROOT, agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  tmpSessions.push(agentGroupId);

  const dbPath = path.join(dir, 'outbound.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_out (
      id          TEXT PRIMARY KEY,
      seq         INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      content     TEXT NOT NULL
    );
  `);
  return db;
}

afterEach(() => {
  // Clean up session directories created in each test
  for (const agentGroupId of tmpSessions) {
    try {
      fs.rmSync(path.join(TEST_ROOT, agentGroupId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpSessions.length = 0;
});

describe('pendingTerminalSpawnOutboundSeenAt', () => {
  it('test_returns_null_no_pending: returns null when only chat messages exist', async () => {
    const { pendingTerminalSpawnOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = TEST_AG_PREFIX + 'null-test';
    const sessionId = 'sess-null-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:00:00.000Z', 'chat', ?)").run(
      JSON.stringify({ text: 'hello world' }),
    );
    db.close();

    const result = pendingTerminalSpawnOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBeNull();
  });

  it('test_returns_min_timestamp: returns earliest timestamp for multiple terminal rows', async () => {
    const { pendingTerminalSpawnOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = TEST_AG_PREFIX + 'min-test';
    const sessionId = 'sess-min-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:01:00.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'spawn_complete', task_id: 'task-1' }),
    );
    db.prepare("INSERT INTO messages_out VALUES ('m2', 2, null, '2026-01-01T00:02:00.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'spawn_complete', task_id: 'task-2' }),
    );
    db.prepare("INSERT INTO messages_out VALUES ('m3', 3, null, '2026-01-01T00:00:30.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'spawn_failed', task_id: 'task-3' }),
    );
    db.close();

    const result = pendingTerminalSpawnOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBe('2026-01-01T00:00:30.000Z');
  });

  it('test_excludes_chat_messages_with_action_word: excludes non-system rows even with action text', async () => {
    const { pendingTerminalSpawnOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = TEST_AG_PREFIX + 'chat-test';
    const sessionId = 'sess-chat-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    // Chat message containing action text — kind='chat' guard must reject it
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:01:00.000Z', 'chat', ?)").run(
      JSON.stringify({ action: 'spawn_complete', text: 'task done' }),
    );
    db.close();

    const result = pendingTerminalSpawnOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBeNull();
  });

  it('test_excludes_false_positive_match: excludes system rows with action as superstring of spawn_complete', async () => {
    const { pendingTerminalSpawnOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = TEST_AG_PREFIX + 'fp-test';
    const sessionId = 'sess-fp-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    // "spawn_complete_other" contains "spawn_complete" as substring — must NOT match
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:01:00.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'spawn_complete_other' }),
    );
    db.close();

    const result = pendingTerminalSpawnOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBeNull();
  });

  it('returns null when outbound.db does not exist', async () => {
    const { pendingTerminalSpawnOutboundSeenAt } = await import('./watchdog.js');
    // No DB created at this path
    const result = pendingTerminalSpawnOutboundSeenAt('ag-nonexistent-xyz', 'sess-nonexistent-xyz');
    expect(result).toBeNull();
  });

  it('matches spawn_failed correctly', async () => {
    const { pendingTerminalSpawnOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = TEST_AG_PREFIX + 'failed-test';
    const sessionId = 'sess-failed-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:05:00.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'spawn_failed', task_id: 'task-1' }),
    );
    db.close();

    const result = pendingTerminalSpawnOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBe('2026-01-01T00:05:00.000Z');
  });
});

// Codex P2 (thread PRRT_kwDORfvfVM6fE-8N): the pre-seam open
// (`new Database(dbPath, { readonly: true })`, no `timeout` key) took
// better-sqlite3's own default of 5000ms, not "none" — the seam's 1s
// fleet-fan-out default was a real regression here, not a tolerant one. A
// read that times out early answers null — "no terminal spawn seen" — which
// bypasses the drain-first guard and can fail a task whose
// spawn_complete/spawn_failed is still on its way in under lock contention.
describe('pendingTerminalSpawnOutboundSeenAt busy_timeout', () => {
  it('passes the write path busy_timeout (5s, no journal recovery) to readSessionOutbound', async () => {
    const spy = vi.spyOn(mailboxIndex, 'readSessionOutbound').mockReturnValue(undefined);
    const { pendingTerminalSpawnOutboundSeenAt } = await import('./watchdog.js');
    pendingTerminalSpawnOutboundSeenAt('ag-wd-opts', 'sess-wd-opts');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual({ agentGroupId: 'ag-wd-opts', sessionId: 'sess-wd-opts' });
    // No `recoverJournal`: the pre-seam open never recovered a hot journal
    // either, so the fix restates that behavior exactly rather than widening
    // it — only the timeout regressed.
    expect(spy.mock.calls[0]?.[2]).toEqual({ busyTimeoutMs: 5000 });
    spy.mockRestore();
  });

  // Deterministic, environment-independent proof the guard survives real lock
  // contention: a separate PROCESS holds an EXCLUSIVE write transaction on
  // outbound.db for longer than the seam's old 1s default but well inside the
  // fixed 5s. better-sqlite3 is synchronous, so a same-process lock (e.g. a
  // second connection plus a same-thread timer) can never interleave with the
  // watchdog's own synchronous read — the read would simply block the one JS
  // thread the "releasing" timer also needs. A child process is the only way
  // to hold the lock concurrently with the parent's read.
  it('reads through real lock contention that outlasts the old 1s default', async () => {
    const agentGroupId = TEST_AG_PREFIX + 'lock-test';
    const sessionId = 'sess-lock-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:05:00.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'spawn_complete', task_id: 'task-1' }),
    );
    db.close();
    const dbPath = path.join(TEST_ROOT, agentGroupId, sessionId, 'outbound.db');

    // Codex P2 (thread PRRT_kwDORfvfVM6fFQHh): a fixed delay before starting
    // the parent read raced the child under load — the child might not have
    // run BEGIN EXCLUSIVE yet, so the read would find the lock free, return
    // instantly, and the elapsed-time assertion would fail spuriously (and
    // throwing there skipped `holder.kill()`, leaking the child into
    // teardown). The child now prints a line to stdout the instant it holds
    // the lock, and the parent's read starts only once it has seen that line
    // — no fixed timer, no race either direction.
    //
    // Holds an EXCLUSIVE transaction for ~1.5s (past the old 1s default,
    // inside the fixed 5s) before committing and exiting.
    const child = `
      const Database = require('better-sqlite3');
      const db = new Database(${JSON.stringify(dbPath)});
      db.prepare('BEGIN EXCLUSIVE').run();
      console.log('locked');
      setTimeout(() => {
        db.prepare('COMMIT').run();
        db.close();
        process.exit(0);
      }, 1500);
    `;
    const holder = spawn(process.execPath, ['-e', child], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] });

    try {
      await new Promise<void>((resolve, reject) => {
        let buf = '';
        holder.stdout!.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes('locked')) resolve();
        });
        holder.once('exit', (code) => reject(new Error(`lock holder exited early (code ${code})`)));
        holder.once('error', reject);
      });

      const start = Date.now();
      const { pendingTerminalSpawnOutboundSeenAt } = await import('./watchdog.js');
      // With the fix (5s busy_timeout): waits out the child's remaining hold
      // and reads the committed row. Without it (1s default): times out well
      // before the child commits and answers null — the false "no terminal
      // spawn seen" this whole fix exists to close.
      const result = pendingTerminalSpawnOutboundSeenAt(agentGroupId, sessionId);
      const elapsedMs = Date.now() - start;
      // eslint-disable-next-line no-console
      console.log(`[lock-test] elapsed waiting on the held lock: ${elapsedMs}ms`);

      expect(result).toBe('2026-01-01T00:05:00.000Z');
      // Proves the read actually waited on the lock rather than finding it
      // already free — a read that returned instantly wouldn't demonstrate
      // contention tolerance at all. The lock was confirmed held immediately
      // before this, so any wait here is against the child's own hold, not a
      // race on the start line above.
      expect(elapsedMs).toBeGreaterThan(300);
    } finally {
      holder.kill();
    }
  }, 20000);
});
