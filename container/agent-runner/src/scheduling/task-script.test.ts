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

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getPendingMessages, markScriptSkipped } from '../db/messages-in.js';
import { applyPreTaskScripts } from './task-script.js';

// Point the pre-task classifier at the real shared destructive core (same
// module the interactive Bash gate uses). In a container this lives at
// /workspace/plugins/...; on the host test runner it's the bootstrap checkout.
const REAL_CORE =
  '/home/ubuntu/plugins/bootstrap/plugins/workflow-agents/hooks/guards/block-destructive-core.ts';
const savedCore = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;

beforeEach(() => {
  process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = REAL_CORE;
  initTestSessionDb();
});

afterEach(() => {
  if (savedCore === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = savedCore;
  closeSessionDb();
});

function insertTask(id: string, script: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'task', datetime('now'), 'pending', 1, ?)`,
    )
    .run(id, JSON.stringify({ prompt: 'monitor', script }));
}

const ackStatus = (id: string): string | undefined =>
  (getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as { status: string } | undefined)
    ?.status;

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
