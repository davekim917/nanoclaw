/**
 * Fleet-hardening Phase 1.1: host-side pre-task script gating.
 *
 * Covers the classifier (clean / hard-block / gated) and the sweep-facing
 * runHostGatedTaskScripts, which must:
 *   - actually execute a clean script and act on wakeAgent
 *   - fall back to the (unchanged) container path for anything the
 *     classifier flags, without running it host-side
 *   - never leak the host process's env into the child (only PATH/HOME/TZ)
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTaskRow } from './db.js';
import { classifyForHostExecution, runHostGatedTaskScripts } from './host-script.js';

const TEST_DIR = '/tmp/nanoclaw-host-script-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function insertHostGatedTask(
  db: ReturnType<typeof openInboundDb>,
  id: string,
  script: string,
  overrides: Record<string, unknown> = {},
): void {
  insertTaskRow(db, {
    id,
    seriesId: id,
    processAfter: new Date(Date.now() - 1_000).toISOString(),
    recurrence: null,
    content: JSON.stringify({ prompt: 'monitor', script, scriptHost: true, ...overrides }),
  });
}

function rowStatus(db: ReturnType<typeof openInboundDb>, id: string): string {
  return (db.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;
}

function rowContent(db: ReturnType<typeof openInboundDb>, id: string): Record<string, unknown> {
  return JSON.parse(
    (db.prepare('SELECT content FROM messages_in WHERE id = ?').get(id) as { content: string }).content,
  );
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('classifyForHostExecution', () => {
  it('allows an ordinary curl/jq monitor script', () => {
    expect(
      classifyForHostExecution(
        'c=$(curl -sf https://example.com | jq length) || exit 0\necho "{\\"wakeAgent\\": false}"',
      ),
    ).toEqual({
      safe: true,
    });
  });

  it('hard-blocks rm -rf', () => {
    const result = classifyForHostExecution('rm -rf /workspace/agent/scratch');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('hard-block');
  });

  it('gates a destructive SQL statement (DROP TABLE)', () => {
    const result = classifyForHostExecution('psql -c "DROP TABLE customers"');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('gated');
  });
});

describe('runHostGatedTaskScripts', () => {
  it('runs a clean wakeAgent=false script and marks it completed without a container', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-gated', 'echo \'{"wakeAgent": false}\'');

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(rowStatus(db, 't-gated')).toBe('completed');
    db.close();
  });

  it('runs a clean wakeAgent=true script and injects scriptOutput, leaving the row pending for admission', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-wake', 'echo \'{"wakeAgent": true, "data": {"alerts": 3}}\'');

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(rowStatus(db, 't-wake')).toBe('pending');
    expect(rowContent(db, 't-wake').scriptOutput).toEqual({ alerts: 3 });
    db.close();
  });

  it('marks an erroring script failed (so recurrence backoff can see it)', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-err', 'echo boom >&2; exit 1');

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(rowStatus(db, 't-err')).toBe('failed');
    db.close();
  });

  it('a classifier-flagged rm -rf script never executes host-side and falls back to the container', async () => {
    const db = freshDb();
    // If this ran, it would write a marker file — assert it never does.
    const marker = path.join(TEST_DIR, 'ran.marker');
    insertHostGatedTask(
      db,
      't-danger',
      `touch ${marker}\nrm -rf /workspace/agent/scratch\necho '{"wakeAgent": false}'`,
    );

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(fs.existsSync(marker)).toBe(false);
    // Row untouched: still pending/trigger=0, no scriptOutput — the normal
    // admission + container path picks it up exactly as before this feature.
    expect(rowStatus(db, 't-danger')).toBe('pending');
    expect(rowContent(db, 't-danger').scriptOutput).toBeUndefined();
    db.close();
  });

  it('a classifier-flagged DROP TABLE script never executes host-side and falls back to the container', async () => {
    const db = freshDb();
    const marker = path.join(TEST_DIR, 'ran.marker');
    insertHostGatedTask(db, 't-sql', `touch ${marker}\npsql -c "DROP TABLE customers"\necho '{"wakeAgent": false}'`);

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(fs.existsSync(marker)).toBe(false);
    expect(rowStatus(db, 't-sql')).toBe('pending');
    db.close();
  });

  it('a managed Git maintenance script never executes host-side and leaves its marker absent', async () => {
    const db = freshDb();
    const marker = path.join(TEST_DIR, 'managed-git-ran.marker');
    insertHostGatedTask(
      db,
      't-managed-git',
      `touch ${marker}\ncommand git --git-dir=/host/canonical/.git worktree prune --expire now\necho '{"wakeAgent": false}'`,
    );

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(fs.existsSync(marker)).toBe(false);
    expect(rowStatus(db, 't-managed-git')).toBe('pending');
    expect(rowContent(db, 't-managed-git').scriptOutput).toBeUndefined();
    db.close();
  });

  it('never leaks the host process env into the script — only PATH/HOME/TZ', async () => {
    const db = freshDb();
    const before = process.env.HOST_SCRIPT_TEST_CANARY;
    process.env.HOST_SCRIPT_TEST_CANARY = 'should-not-leak';
    try {
      insertHostGatedTask(
        db,
        't-env',
        'echo "{\\"wakeAgent\\": true, \\"data\\": {\\"canary\\": \\"${HOST_SCRIPT_TEST_CANARY:-absent}\\"}}"',
      );
      await runHostGatedTaskScripts(db, 'sess-test');
      expect(rowContent(db, 't-env').scriptOutput).toEqual({ canary: 'absent' });
    } finally {
      if (before === undefined) delete process.env.HOST_SCRIPT_TEST_CANARY;
      else process.env.HOST_SCRIPT_TEST_CANARY = before;
    }
    db.close();
  });

  it('ignores task rows without scriptHost — the existing container path is untouched', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-container-only', 'echo \'{"wakeAgent": false}\'', { scriptHost: false });

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(rowStatus(db, 't-container-only')).toBe('pending');
    expect(rowContent(db, 't-container-only').scriptOutput).toBeUndefined();
    db.close();
  });
});

/** True once `pid` is gone. Polls, because a just-SIGKILLed process is briefly
 *  a zombie and still answers `kill(pid, 0)` until Node reaps it (~100ms). */
async function gone(pid: number, withinMs = 2_000): Promise<boolean> {
  const until = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('runHostScript hard deadline', () => {
  // REGRESSION GUARD. The predecessor of this test ran a script whose
  // GRANDCHILD outlived bash and asserted only `result === null` and
  // `elapsed < 15_000`. It passed in 311ms — via execFile's own timeout —
  // and therefore never executed one line of the deadline. Deleting the
  // whole deadline left it green (audit, 2026-08-26).
  //
  // A grandchild cannot reach the deadline: execFile's timeout tears down the
  // parent's pipe ends, so the callback still fires at T. The ONLY thing that
  // gets past T is a DIRECT child that does not die on SIGTERM — execFile's
  // timeout sends SIGTERM, and the callback waits on an exit that never comes.
  // `trap '' TERM` is the cheap deterministic stand-in for the real cases
  // (uninterruptible D-state, SIGSTOP). classifyForHostExecution does not
  // block `trap`, and these scripts are agent-authored, so this is reachable.
  it('SIGKILLs a SIGTERM-proof script at the deadline, not at the timeout', async () => {
    vi.resetModules();
    // Deadline is timeout + 10s, so these must be far enough apart to tell
    // "resolved at the timeout" from "resolved at the deadline".
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '1000');
    try {
      const { runHostScript } = await import('./host-script.js');
      const started = Date.now();
      const result = await runHostScript("trap '' TERM\nsleep 60\n", 'deadline-test');
      const elapsed = Date.now() - started;

      expect(result).toBeNull();
      // The load-bearing assertion: resolution came from the DEADLINE (~11s),
      // not from execFile's timeout (~1s). Delete the deadline and this fails
      // by hanging until the test timeout — which is the point.
      expect(elapsed).toBeGreaterThanOrEqual(10_000);
      expect(elapsed).toBeLessThan(14_000);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);

  it('leaves no surviving direct child behind', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '1000');
    try {
      const { runHostScript } = await import('./host-script.js');
      // The script records its own pid so we can prove the SIGKILL landed
      // rather than inferring it from the promise resolving.
      const pidFile = path.join(TEST_DIR, 'deadline-child.pid');
      fs.mkdirSync(TEST_DIR, { recursive: true });
      await runHostScript(`trap '' TERM\necho $$ > ${pidFile}\nsleep 60\n`, 'deadline-pid-test');

      const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(childPid)).toBe(true);

      // Poll rather than checking once: at the instant the deadline resolves,
      // the SIGKILLed child is a ZOMBIE (measured `/proc/<pid>/stat` state `Z`)
      // and still answers `kill(pid, 0)`. Node reaps it within ~100ms. Polling
      // keeps the assertion portable — no /proc — without racing the reap.
      // A SIGTERM-only kill would leave it genuinely alive for the full 2s,
      // because the script traps TERM.
      expect(await gone(childPid)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);

  // THE POINT OF spawn() + detached. Killing bash does not kill what bash
  // started: a `gh api` fan-out or a `capped-check.sh` run is a GRANDCHILD, and
  // signalling the direct child alone orphans it. Before this change the code
  // tried `process.kill(-child.pid)` while passing `detached` to execFile,
  // which silently drops it — so the child was never a group leader, that call
  // only ever threw ESRCH, and every descendant survived. Verified at the time:
  // a grandchild outlived the kill and completed its side effect 6s later.
  //
  // The grandchild here is deliberately NOT `timeout`-wrapped. Nothing in
  // classifyForHostExecution requires scripts to bound their own children, and
  // they are agent-authored, so descendant cleanup must not rest on that.
  it('kills GRANDCHILDREN too, not just the direct child', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '1000');
    try {
      const { runHostScript } = await import('./host-script.js');
      fs.mkdirSync(TEST_DIR, { recursive: true });
      const gcPid = path.join(TEST_DIR, 'grandchild.pid');
      const gcMarker = path.join(TEST_DIR, 'grandchild.marker');

      // Backgrounded grandchild records its pid, then tries to write a marker
      // well after the deadline. bash traps TERM so only the group SIGKILL can
      // stop the pair.
      await runHostScript(
        `trap '' TERM\n( echo $BASHPID > ${gcPid}; sleep 40; touch ${gcMarker} ) &\nsleep 60\n`,
        'grandchild-test',
      );

      const grandchildPid = Number(fs.readFileSync(gcPid, 'utf8').trim());
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(await gone(grandchildPid)).toBe(true);
      // Belt and braces: it never got far enough to run its side effect.
      expect(fs.existsSync(gcMarker)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);
});
