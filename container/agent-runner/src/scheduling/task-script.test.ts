/**
 * Container leg of the script-failure backoff chain, tested at unit level so
 * the e2e suite doesn't need a live multi-sweep scenario for it:
 *
 *   script error → applyPreTaskScripts skips with reason 'error'
 *   → markScriptSkipped acks `script-skip:error` in outbound.db
 *   (gated → plain 'completed': the monitor working as designed).
 *
 * The host leg (ack → FAILED run → streak backoff) is pinned in
 * src/db/session-db.test.ts and src/modules/scheduling/recurrence.test.ts —
 * both sides pin the literal 'script-skip:error'; if either renames it, its
 * own test goes red.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';

import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { getPendingMessages, markScriptSkipped } from '../db/messages-in.js';
import { applyPreTaskScripts, runScript } from './task-script.js';

// Point the pre-task classifier at the real shared destructive core (same
// module the interactive Bash gate uses). In a container this lives at
// /workspace/plugins/...; on the host test runner it's the bootstrap checkout.
const REAL_CORE = '/home/ubuntu/plugins/bootstrap/plugins/workflow-agents/hooks/guards/block-destructive-core.ts';
const savedCore = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
const savedHostDataDir = process.env.NANOCLAW_HOST_DATA_DIR;
const savedHostTopicWorktreesDir = process.env.NANOCLAW_HOST_TOPIC_WORKTREES_DIR;
const markerPaths = new Set<string>();

beforeEach(() => {
  process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = REAL_CORE;
  process.env.NANOCLAW_HOST_DATA_DIR = '/srv/nanoclaw/data';
  process.env.NANOCLAW_HOST_TOPIC_WORKTREES_DIR = '/srv/nanoclaw/data/topic-worktrees';
  initTestSessionDb();
});

afterEach(() => {
  if (savedCore === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = savedCore;
  if (savedHostDataDir === undefined) delete process.env.NANOCLAW_HOST_DATA_DIR;
  else process.env.NANOCLAW_HOST_DATA_DIR = savedHostDataDir;
  if (savedHostTopicWorktreesDir === undefined) delete process.env.NANOCLAW_HOST_TOPIC_WORKTREES_DIR;
  else process.env.NANOCLAW_HOST_TOPIC_WORKTREES_DIR = savedHostTopicWorktreesDir;
  for (const markerPath of markerPaths) {
    try {
      fs.unlinkSync(markerPath);
    } catch {
      // Missing means the guarded script did not execute, which is expected.
    }
  }
  markerPaths.clear();
  closeSessionDb();
});

function freshMarker(name: string): string {
  const markerPath = `/tmp/nanoclaw-task-script-${process.pid}-${name}`;
  try {
    fs.unlinkSync(markerPath);
  } catch {
    // Already absent.
  }
  markerPaths.add(markerPath);
  return markerPath;
}

function insertTask(id: string, script: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'task', datetime('now'), 'pending', 1, ?)`,
    )
    .run(id, JSON.stringify({ prompt: 'monitor', script }));
}

const ackStatus = (id: string): string | undefined =>
  (
    getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined
  )?.status;

describe('script-skip ack chain (container leg)', () => {
  it('an erroring script skips with reason "error" and acks script-skip:error', async () => {
    insertTask('t-err', 'echo boom >&2; exit 1');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(keep).toHaveLength(0);
    expect(skipped).toEqual([{ id: 't-err', reason: 'error' }]);

    markScriptSkipped(skipped);
    expect(ackStatus('t-err')).toBe('script-skip:error');
  });

  it('a deliberate wakeAgent=false gate acks plain completed — never backs off', async () => {
    insertTask('t-gated', 'echo \'{"wakeAgent": false}\'');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(keep).toHaveLength(0);
    expect(skipped).toEqual([{ id: 't-gated', reason: 'gated' }]);

    markScriptSkipped(skipped);
    expect(ackStatus('t-gated')).toBe('completed');
  });

  it('wakeAgent=true keeps the task and enriches the prompt with script data', async () => {
    insertTask('t-wake', 'echo \'{"wakeAgent": true, "data": {"alerts": 2}}\'');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(skipped).toHaveLength(0);
    expect(keep).toHaveLength(1);
    expect(JSON.parse(keep[0].content).scriptOutput).toEqual({ alerts: 2 });
  });

  // Fleet-hardening Phase 1.1: a host-gated fire (content.scriptHost) already
  // ran its script on the host and wrote scriptOutput before the container
  // was even spawned (src/modules/scheduling/host-script.ts). The container
  // must not run it a second time.
  it('a row that already carries scriptOutput is passed through without re-running the script', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
         VALUES ('t-host-gated', 'task', datetime('now'), 'pending', 1, ?)`,
      )
      .run(
        JSON.stringify({
          prompt: 'monitor',
          script: 'exit 1', // would fail if re-run — proves it never executes
          scriptHost: true,
          scriptOutput: { alerts: 5 },
        }),
      );

    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(skipped).toHaveLength(0);
    expect(keep).toHaveLength(1);
    expect(JSON.parse(keep[0].content).scriptOutput).toEqual({ alerts: 5 });
  });
});

// Fleet-hardening Phase 4, P1 leg 2: a pre-task script runs unattended with no
// approval round-trip, so it must be classified by the SAME destructive-command
// core as the interactive Bash gate, and its subprocess env must be sanitized of
// auth secrets — otherwise `ncl tasks create --script` was an ungated exec path.
describe('pre-task script destructive-classifier gate (P1 leg 2)', () => {
  it('refuses a destructive script (rm -rf) — never executes it, acks script-skip:error', async () => {
    // If it ran, the `touch` side effect would prove execution — but block
    // means runScript is never reached, so only the ack is observable.
    insertTask('t-rm', 'rm -rf /workspace/workgroup\necho \'{"wakeAgent": false}\'');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(keep).toHaveLength(0);
    expect(skipped).toEqual([{ id: 't-rm', reason: 'blocked' }]);

    markScriptSkipped(skipped);
    expect(ackStatus('t-rm')).toBe('script-skip:error');
  });

  it('refuses a gated destructive script (DROP TABLE) the same way', async () => {
    insertTask('t-drop', 'sqlite3 x.db "DROP TABLE users"\necho \'{"wakeAgent": true}\'');
    const { skipped } = await applyPreTaskScripts(getPendingMessages());
    expect(skipped).toEqual([{ id: 't-drop', reason: 'blocked' }]);
  });

  it('lets a legit credentialed monitor script through (curl | jq)', async () => {
    insertTask('t-ok', 'echo \'{"wakeAgent": true, "data": {"n": 1}}\'');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());
    expect(skipped).toHaveLength(0);
    expect(JSON.parse(keep[0].content).scriptOutput).toEqual({ n: 1 });
  });

  it('strips auth secrets from the script env but keeps ordinary vars', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    process.env.TASK_SCRIPT_KEEP = 'kept';
    try {
      insertTask(
        't-env',
        'echo "{\\"wakeAgent\\": true, \\"data\\": {\\"secret\\": \\"$ANTHROPIC_API_KEY\\", \\"kept\\": \\"$TASK_SCRIPT_KEEP\\"}}"',
      );
      const { keep } = await applyPreTaskScripts(getPendingMessages());
      const out = JSON.parse(keep[0].content).scriptOutput;
      expect(out.secret).toBe(''); // stripped
      expect(out.kept).toBe('kept'); // ordinary var survives
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.TASK_SCRIPT_KEEP;
    }
  });
});

describe('pre-task managed Git guard', () => {
  it('blocks managed worktree maintenance before any script side effect', async () => {
    const marker = freshMarker('worktree-prune');
    insertTask(
      't-managed-worktree-prune',
      `git --git-dir="$NANOCLAW_HOST_DATA_DIR/repositories/wg/repo/.git" worktree prune\ntouch ${marker}\necho '{"wakeAgent": true}'`,
    );

    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(keep).toHaveLength(0);
    expect(skipped).toEqual([{ id: 't-managed-worktree-prune', reason: 'blocked' }]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('blocks managed Git object maintenance before any script side effect', async () => {
    const marker = freshMarker('git-gc');
    insertTask(
      't-managed-git-gc',
      `git -C "$NANOCLAW_HOST_DATA_DIR/repositories/wg/repo" gc\ntouch ${marker}\necho '{"wakeAgent": true}'`,
    );

    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(keep).toHaveLength(0);
    expect(skipped).toEqual([{ id: 't-managed-git-gc', reason: 'blocked' }]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('still executes an ordinary safe script when managed Git paths are configured', async () => {
    const marker = freshMarker('safe-command');
    insertTask('t-managed-safe', `touch ${marker}\necho '{"wakeAgent": true, "data": {"safe": true}}'`);

    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(skipped).toHaveLength(0);
    expect(keep).toHaveLength(1);
    expect(JSON.parse(keep[0]!.content).scriptOutput).toEqual({ safe: true });
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('a timed-out script is reported as a timeout', () => {
  /**
   * execFile kills on timeout, so the callback receives a generic
   * "Command failed" — the same shape a script that exited non-zero produces.
   * `killed` is the only thing that tells them apart. Without it the log said
   * `error: Command failed: bash /tmp/task-script-<id>.sh` for a script that
   * merely ran long, which reads as a broken script and sends whoever is
   * debugging it looking for a bug that isn't there. The fork's 120s ceiling
   * and 8-failure auto-pause make that misread expensive: the series pauses
   * and the operator never learns the ceiling was the cause.
   */
  const captureLogs = async (fn: () => Promise<unknown>): Promise<string[]> => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      await fn();
    } finally {
      console.error = original;
    }
    return lines;
  };

  it('names the timeout and the ceiling it hit, not a generic command failure', async () => {
    const lines = await captureLogs(() => runScript('sleep 5', 't-timeout', 150));
    const joined = lines.join('\n');
    expect(joined).toContain('[t-timeout] timed out after 150ms');
    expect(joined).toContain('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS');
    expect(joined).not.toContain('error: Command failed');
  });

  it('still resolves null, so the task is skipped exactly as before', async () => {
    await captureLogs(async () => {
      expect(await runScript('sleep 5', 't-timeout-null', 150)).toBeNull();
    });
  });

  it('leaves a genuine non-zero exit reported as an error', async () => {
    const lines = await captureLogs(() => runScript('exit 3', 't-exit', 5000));
    const joined = lines.join('\n');
    expect(joined).toContain('error: Command failed');
    expect(joined).not.toContain('timed out');
  });

  it("a timed-out script still acks 'script-skip:error', so auto-pause accounting is unchanged", async () => {
    // The skip reason stays 'error' on purpose. A script that hangs every fire
    // is as broken as one that exits 1, and the 8-consecutive-failure pause
    // (src/modules/scheduling/recurrence.ts, SCRIPT_FAIL_PAUSE_CAP) is exactly
    // the right response. Only the log line that tells the operator WHY it
    // failed changes — the ack the host counts does not.
    process.env.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS = '150';
    try {
      insertTask('t-timeout-ack', 'sleep 5');
      let outcome!: Awaited<ReturnType<typeof applyPreTaskScripts>>;
      const lines = await captureLogs(async () => {
        outcome = await applyPreTaskScripts(getPendingMessages());
      });

      expect(outcome.keep).toHaveLength(0);
      expect(outcome.skipped).toEqual([{ id: 't-timeout-ack', reason: 'error' }]);
      expect(lines.join('\n')).toContain('[t-timeout-ack] timed out after 150ms');

      markScriptSkipped(outcome.skipped);
      expect(ackStatus('t-timeout-ack')).toBe('script-skip:error');
    } finally {
      delete process.env.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS;
    }
  });
});
