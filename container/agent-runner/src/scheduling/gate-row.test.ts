/**
 * Record, then act: every pre-task script execution leaves a gate row the host
 * records BEFORE the occurrence is acked or handed to the agent. The host is
 * the judge; the row carries the raw result, or the reason there is none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getPendingMessages, markScriptSkipped } from '../db/messages-in.js';
import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { applyPreTaskScripts } from './task-script.js';

/** The pre-task classifier reads the real shared destructive core, as task-script.test.ts does. */
const CLASSIFIER_ENV: Record<string, string> = {
  NANOCLAW_DESTRUCTIVE_GUARD_CORE:
    '/home/ubuntu/plugins/bootstrap/plugins/workflow-agents/hooks/guards/block-destructive-core.ts',
  NANOCLAW_HOST_DATA_DIR: '/srv/nanoclaw/data',
  NANOCLAW_HOST_TOPIC_WORKTREES_DIR: '/srv/nanoclaw/data/topic-worktrees',
};
const savedEnv = new Map<string, string | undefined>();
let scratch = '';

beforeEach(() => {
  for (const [name, value] of Object.entries(CLASSIFIER_ENV)) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-row-'));
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

function queueTask(id: string, content: Record<string, unknown>): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'task', datetime('now'), 'pending', 1, ?)`,
    )
    .run(id, JSON.stringify({ prompt: 'monitor', ...content }));
}

function ack(id: string): string | undefined {
  const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
    | { status: string }
    | undefined;
  return row?.status;
}

interface GateRow {
  seq: number;
  in_reply_to: string | null;
  content: string;
  gate: Record<string, unknown>;
}

function gateRows(): GateRow[] {
  const rows = getOutboundDb()
    .prepare("SELECT seq, in_reply_to, content FROM messages_out WHERE kind = 'task_log' ORDER BY seq")
    .all() as Array<Omit<GateRow, 'gate'>>;
  return rows.map((row) => ({ ...row, gate: JSON.parse(row.content).gate }));
}

const UNREADABLE = { kind: 'unreadable', evidence: 'api 502', bound: '90m' };
const printed = (line: unknown): string => `echo '${JSON.stringify(line)}'`;

describe('gate rows', () => {
  it('writes the raw result before the ack, as a task_log with no auto flag and no in_reply_to', async () => {
    queueTask('t-observed', { script: printed({ wakeAgent: false, observation: UNREADABLE, data: { n: 1 } }) });

    const { skipped } = await applyPreTaskScripts(getPendingMessages());

    // Written, and not yet acked: the ack is the caller's next step.
    expect(ack('t-observed')).toBeUndefined();
    const rows = gateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.in_reply_to).toBeNull();
    expect(JSON.parse(rows[0]!.content)).toEqual({
      gate: { occurrenceId: 't-observed', wakeAgent: false, observation: UNREADABLE },
    });
    expect(skipped).toEqual([{ id: 't-observed', reason: 'gated' }]);
  });

  it('forwards a result with no observation as exactly that', async () => {
    queueTask('t-undeclared', { script: printed({ wakeAgent: false }) });
    await applyPreTaskScripts(getPendingMessages());
    expect(gateRows()[0]!.gate).toEqual({ occurrenceId: 't-undeclared', wakeAgent: false });
  });

  it('records a wake, and still hands the task to the agent', async () => {
    queueTask('t-wakes', { script: printed({ wakeAgent: true, data: { n: 2 } }) });
    const { keep } = await applyPreTaskScripts(getPendingMessages());
    expect(gateRows()[0]!.gate).toEqual({ occurrenceId: 't-wakes', wakeAgent: true });
    expect(keep.map((m) => m.id)).toEqual(['t-wakes']);
  });

  it('carries the reason a script failed', async () => {
    queueTask('t-exit', { script: 'echo nope >&2; exit 4' });
    await applyPreTaskScripts(getPendingMessages());
    const { gate } = gateRows()[0]!;
    expect(gate.occurrenceId).toBe('t-exit');
    expect(gate.wakeAgent).toBe(false);
    expect(String(gate.error)).toMatch(/^error: Command failed: bash /);
  });

  it('carries the reason for a real execFile kill at the timeout', async () => {
    process.env.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS = '150';
    try {
      queueTask('t-killed', { script: 'sleep 5' });
      await applyPreTaskScripts(getPendingMessages());
    } finally {
      delete process.env.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS;
    }
    expect(String(gateRows()[0]!.gate.error)).toContain('timed out after 150ms and was killed');
  });

  it('records a classifier refusal as a failure with its reason', async () => {
    queueTask('t-refused', { script: `rm -rf /workspace/workgroup\n${printed({ wakeAgent: false })}` });
    await applyPreTaskScripts(getPendingMessages());
    expect(String(gateRows()[0]!.gate.error)).toMatch(/^refused by the destructive-command classifier: /);
  });

  it('writes nothing for a row whose result the host already recorded', async () => {
    queueTask('t-host', { script: 'exit 1', scriptHost: true, scriptOutput: { n: 3 } });
    await applyPreTaskScripts(getPendingMessages());
    expect(gateRows()).toEqual([]);
  });

  it('a crash between the gate row and the ack runs the script again and writes a later row', async () => {
    const counter = path.join(scratch, 'runs');
    queueTask('t-rerun', {
      script:
        `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}\n` +
        `if [ $n -eq 1 ]; then ${printed({ wakeAgent: false, observation: { kind: 'empty', evidence: 'x', bound: '1h' } })}; ` +
        `else ${printed({ wakeAgent: false, observation: UNREADABLE })}; fi`,
    });

    await applyPreTaskScripts(getPendingMessages()); // then the container dies before acking
    const { skipped } = await applyPreTaskScripts(getPendingMessages());
    markScriptSkipped(skipped);

    const rows = gateRows();
    expect(rows.map((r) => (r.gate.observation as { kind: string }).kind)).toEqual(['empty', 'unreadable']);
    expect(rows[1]!.seq).toBeGreaterThan(rows[0]!.seq);
    expect(ack('t-rerun')).toBe('completed');
  });

  it('leaves the occurrence unacked when its gate row cannot be written, so it runs again', async () => {
    queueTask('t-unwritten', { script: printed({ wakeAgent: true }) });
    const pending = getPendingMessages();
    getOutboundDb().exec('ALTER TABLE messages_out RENAME TO messages_out_unreachable');
    let outcome!: Awaited<ReturnType<typeof applyPreTaskScripts>>;
    try {
      outcome = await applyPreTaskScripts(pending);
    } finally {
      getOutboundDb().exec('ALTER TABLE messages_out_unreachable RENAME TO messages_out');
    }

    expect(outcome.keep).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(getPendingMessages().map((m) => m.id)).toContain('t-unwritten');
  });
});
