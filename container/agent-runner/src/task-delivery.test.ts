/**
 * One-door delivery in task sessions.
 *
 * Every outbound tool call names its destination. In a task run, final output
 * is inert delivery-wise and becomes the automatic run summary instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { sendFile, sendMessage } from './mcp-tools/core.js';
import {
  autoAppendTaskLog,
  buildTaskBlockNudge,
  dispatchResultText,
  resolveFireOutcome,
  shouldNudgeTaskBlocks,
} from './poll-loop.js';
import type { RoutingContext } from './formatter.js';

function seedSessionRouting(channelType: string | null, platformId: string | null, threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(channelType, platformId, threadId);
}

function seedDestination(name = 'family', channelType = 'telegram', platformId = 'telegram:99'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

const taskRouting: RoutingContext = {
  platformId: 'ag-1',
  channelType: 'agent',
  threadId: 'system:tasks:daily-digest-a1b2',
  inReplyTo: 'run-1',
  taskRun: true,
};

beforeEach(() => {
  initTestSessionDb();
  seedDestination();
});

afterEach(() => {
  closeSessionDb();
});

describe('explicit outbound destinations', () => {
  it('derives task mode from the canonical per-series thread without a DB migration', () => {
    seedSessionRouting(null, null, 'system:tasks:daily-digest-a1b2');
    expect(getTaskSeriesId()).toBe('daily-digest-a1b2');

    seedSessionRouting('telegram', 'telegram:99', 'chat-thread');
    expect(getTaskSeriesId()).toBeNull();
  });

  it('keeps `to` optional in the shared schemas so chat replies can use current-conversation routing', async () => {
    expect(sendMessage.tool.inputSchema.required).not.toContain('to');
    expect(sendFile.tool.inputSchema.required).not.toContain('to');
  });

  it('never infers the only destination in a task session when `to` is omitted', async () => {
    seedSessionRouting(null, null, 'system:tasks:daily-digest-a1b2');

    const messageResult = (await sendMessage.handler({ text: 'hello' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const fileResult = (await sendFile.handler({ path: 'report.txt' })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    for (const result of [messageResult, fileResult]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('to is required');
      expect(result.content[0].text).toContain('family');
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects an unknown explicit destination without falling back', async () => {
    const messageResult = (await sendMessage.handler({ to: 'missing', text: 'hello' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const fileResult = (await sendFile.handler({ to: 'missing', path: 'report.txt' })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    for (const result of [messageResult, fileResult]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown destination "missing"');
      expect(result.content[0].text).toContain('Known: family');
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('delivers to the explicitly named destination', async () => {
    seedSessionRouting(null, null, 'system:tasks:daily-digest-a1b2');

    await sendMessage.handler({ to: 'family', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('telegram:99');
  });

  it('preserves the current thread for an explicitly named matching destination', async () => {
    seedDestination('current-chat', 'discord', 'channel:1');
    seedSessionRouting('discord', 'channel:1', 'thread-7');

    await sendMessage.handler({ to: 'current-chat', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('channel:1');
    expect(out[0].thread_id).toBe('thread-7');
  });
});

describe('final-output blocks in a task run', () => {
  it('keeps them inert and returns their destination and content for correction', async () => {
    const { sent, hasUnwrapped, taskBlocks } = await dispatchResultText(
      '<message to="family">digest is ready</message>',
      taskRouting,
    );

    expect(sent).toBe(0);
    expect(hasUnwrapped).toBe(false);
    expect(taskBlocks).toEqual([{ to: 'family', body: 'digest is ready' }]);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('still delivers final-output blocks in chat sessions', async () => {
    const { sent, taskBlocks } = await dispatchResultText('<message to="family">hi</message>', {
      ...taskRouting,
      taskRun: false,
    });

    expect(sent).toBe(1);
    expect(taskBlocks).toEqual([]);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('nudges at most once and only when a task result contains inert blocks', async () => {
    const blocks = [{ to: 'family', body: 'digest' }];
    expect(shouldNudgeTaskBlocks(true, blocks, false)).toBe(true);
    expect(shouldNudgeTaskBlocks(true, blocks, true)).toBe(false);
    expect(shouldNudgeTaskBlocks(true, [], false)).toBe(false);
    expect(shouldNudgeTaskBlocks(false, blocks, false)).toBe(false);
  });

  it('shows the exact content and makes re-send conditional', async () => {
    const nudge = buildTaskBlockNudge([{ to: 'family', body: '3 <new> posts & a warning' }], 'family, ops');

    expect(nudge).toContain('to="family"');
    expect(nudge).toContain('3 &lt;new&gt; posts &amp; a warning');
    expect(nudge).toContain('If and only if');
    expect(nudge).toContain('do not send it again');
    expect(nudge).not.toContain('Re-send now');
  });

  it('records the original task result once, not the correction retry', async () => {
    let nudged = false;
    const original = '<message to="family">digest</message>';
    const first = await dispatchResultText(original, taskRouting);
    if (!nudged) await autoAppendTaskLog(original);
    nudged = shouldNudgeTaskBlocks(true, first.taskBlocks, nudged);

    const retry = await dispatchResultText('Delivery decision handled.', taskRouting);
    if (!nudged) await autoAppendTaskLog('Delivery decision handled.');
    expect(shouldNudgeTaskBlocks(true, retry.taskBlocks, nudged)).toBe(false);

    const rows = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as {
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toContain('[undelivered → family] digest');
  });
});

describe('automatic task run summary', () => {
  it('writes a task_log row from final text', async () => {
    await autoAppendTaskLog('Checked  the\nfeeds — nothing new.');

    const rows = getOutboundDb().prepare("SELECT kind, content FROM messages_out WHERE kind = 'task_log'").all() as {
      kind: string;
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Checked the feeds — nothing new.');
  });

  it('marks legacy final-output blocks undelivered and never stores raw XML', async () => {
    await autoAppendTaskLog('Digest done. <message to="family">3 new posts today</message> See you tomorrow.');

    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").get() as {
      content: string;
    };
    const line = JSON.parse(row.content).text as string;
    expect(line).not.toContain('<message');
    expect(line).toContain('[undelivered → family] 3 new posts today');
    expect(line).toContain('Digest done.');
  });

  // ── the 2026-09-07 incident: the provider's error verdict was thrown away ──
  //
  // `processQuery` acts on `event.isError` only when `!routing.taskRun`, so a
  // task run that errored was recorded exactly like one that succeeded. A
  // series pinned to `gpt-6-astra` after its group moved to claude failed 21
  // times in 14 hours with every occurrence reading `completed`. These three
  // cases are what make the host's run-outcome ledger able to tell the two
  // apart at all.
  it('marks the summary as the automatic one so a mid-run note cannot move a streak', async () => {
    await autoAppendTaskLog('Checked the feeds.');
    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").get() as {
      content: string;
    };
    const content = JSON.parse(row.content);
    expect(content.auto).toBe(true);
    expect(content.isError).toBeUndefined();
  });
  it('correlates a single automatic task outcome without changing its summary count', async () => {
    await autoAppendTaskLog('Phase checkpoint saved.', false, 'test-model', ['event-one']);
    const rows = getOutboundDb().prepare("SELECT in_reply_to, content FROM messages_out WHERE kind = 'task_log'").all() as {in_reply_to: string | null; content: string}[];
    expect(rows).toHaveLength(1);
    expect(rows[0].in_reply_to).toBe('event-one');
    expect(JSON.parse(rows[0].content).taskMessageIds).toEqual(['event-one']);
  });
  it('records a batched outcome once without inventing a scalar reply anchor', async () => {
    await autoAppendTaskLog('Batch answered.', true, 'test-model', ['event-one', 'event-two']);
    const rows = getOutboundDb().prepare("SELECT in_reply_to, content FROM messages_out WHERE kind = 'task_log'").all() as {in_reply_to: string | null; content: string}[];
    expect(rows).toHaveLength(1);
    expect(rows[0].in_reply_to).toBeNull();
    expect(JSON.parse(rows[0].content).taskMessageIds).toEqual(['event-one', 'event-two']);
  });

  it("carries the provider's error verdict and the model that ran", async () => {
    await autoAppendTaskLog(
      "Prompt is too long · automatic compaction failed: There's an issue with the selected model (gpt-6-astra).",
      true,
      'gpt-6-astra',
    );
    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").get() as {
      content: string;
    };
    const content = JSON.parse(row.content);
    expect(content.isError).toBe(true);
    expect(content.model).toBe('gpt-6-astra');
    expect(content.text).toContain('issue with the selected model');
  });

  it('still records an errored turn that returned no text at all', async () => {
    // A silent failure is exactly the case where the run log leaves nothing
    // behind, so it is the one that must not be skipped.
    await autoAppendTaskLog('   ', true, 'gpt-6-astra');
    const rows = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as {
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).isError).toBe(true);
  });

  // Codex round 1, P1: the outcome write used to sit inside `if (event.text)`,
  // and `ProviderEvent.text` is `string | null`. A blank SUCCESS therefore
  // recorded nothing — so it could not reset a stale failure streak, and the
  // series stayed "failing" across a recovery.
  it('records a blank SUCCESSFUL turn, which is what resets a stale streak', async () => {
    await autoAppendTaskLog('   ');
    const rows = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as {
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    expect(content.auto).toBe(true);
    expect(content.isError).toBeUndefined();
    expect(content.text).toBe('(run produced no output)');
  });

  // The exact shape that produced 21 dead fires: a provider-level model
  // rejection. It reaches the runner as a terminal error, not as result text.
  it('records a provider model rejection as a failed fire', async () => {
    await autoAppendTaskLog(
      "Error: There's an issue with the selected model (gpt-6-astra). It may not exist or you may not have access to it.",
      true,
      'gpt-6-astra',
    );
    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").get() as {
      content: string;
    };
    const content = JSON.parse(row.content);
    expect(content.isError).toBe(true);
    expect(content.model).toBe('gpt-6-astra');
    expect(content.text).toContain('issue with the selected model');
  });

  it('is additive to an explicit append-log request', async () => {
    await writeMessageOut({
      id: 'cli-progress',
      kind: 'system',
      content: JSON.stringify({
        action: 'cli_request',
        requestId: 'cli-progress',
        command: 'tasks-append-log',
        args: { msg: 'progress note' },
      }),
    });

    await autoAppendTaskLog('final summary');

    expect(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'task_log'").all()).toHaveLength(1);
  });
});

/**
 * Codex round 3, P1 — a deferred batch is not a fire that ended.
 *
 * Both the repository-barrier and provider-fallback paths leave or release the
 * claim so the SAME occurrence runs again. Recording here as well gives one
 * fire two rows, and with the threshold at three that pages a human after two
 * occurrences of a task that was only postponed.
 */
describe('which fires record an outcome', () => {
  const reported = { text: 'watched, nothing new', isError: false, model: 'claude-fable-5-1' };

  it('records a normal terminal fire', () => {
    expect(
      resolveFireOutcome({
        taskRun: true,
        deferredForRepositoryBarrier: false,
        deferredToFallback: false,
        reported,
      }),
    ).toEqual(reported);
  });

  it('records nothing when the batch was deferred to a provider fallback', () => {
    expect(
      resolveFireOutcome({
        taskRun: true,
        deferredForRepositoryBarrier: false,
        deferredToFallback: true,
        reported,
      }),
    ).toBeUndefined();
  });

  it('records nothing when a repository barrier interrupted the batch', () => {
    expect(
      resolveFireOutcome({
        taskRun: true,
        deferredForRepositoryBarrier: true,
        deferredToFallback: false,
        errorMessage: 'barrier',
        model: 'gpt-6-astra',
      }),
    ).toBeUndefined();
  });

  it('synthesises a failure only when every attempt threw', () => {
    expect(
      resolveFireOutcome({
        taskRun: true,
        deferredForRepositoryBarrier: false,
        deferredToFallback: false,
        errorMessage: 'provider exploded',
        model: 'gpt-6-astra',
      }),
    ).toEqual({ text: 'Error: provider exploded', isError: true, model: 'gpt-6-astra' });
  });

  it('prefers a real terminal result over a synthesised failure', () => {
    expect(
      resolveFireOutcome({
        taskRun: true,
        deferredForRepositoryBarrier: false,
        deferredToFallback: false,
        reported,
        errorMessage: 'ignored',
      }),
    ).toEqual(reported);
  });

  it('records nothing for a non-task turn', () => {
    expect(
      resolveFireOutcome({
        taskRun: false,
        deferredForRepositoryBarrier: false,
        deferredToFallback: false,
        reported,
      }),
    ).toBeUndefined();
  });
});
