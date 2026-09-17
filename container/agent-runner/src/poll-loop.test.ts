import { describe, it, expect, beforeEach, afterEach, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import os from 'os';
import path from 'path';

import { evaluateAdmission, registerAdmissionGate } from './admission-gate.js';
import { _resetConfig, loadConfig } from './config.js';
import { clearStaleProcessingAcks, setContainerToolInFlight } from './db/container-state.js';
import { setContinuation } from './db/session-state.js';
import { setStickyModel, setStickyEffort } from './modules/mailbox/session-state.js';
import { getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getTurnUsageRows } from './modules/mailbox/index.js';
import { formatMessages, extractRouting } from './formatter.js';
import {
  dispatchFileAttachment,
  dispatchResultText,
  applyChatBudget,
  applyFlagBatch,
  buildProviderUnavailableReport,
  buildWorkContinuationPrompt,
  handleEvent,
  isAdmissibleTrigger,
  isAupRefusal,
  isCorruptionError,
  processQuery,
  formatMessagesWithCommands,
  runPollLoop,
  retainCompleteRecallPairs,
  selectInTurnFollowUps,
  transientOverloadDelayMs,
} from './poll-loop.js';
import {
  cancelWorkContinuation,
  getWorkContinuation,
  getPendingMessagesWithDiagnostics,
  markWorkContinuationRunning,
  queueWorkContinuation,
} from './modules/mailbox/index.js';
import { MockProvider } from './providers/mock.js';
import { postToolUseHook, preToolUseHook } from './providers/claude.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('container startup recovery', () => {
  it('clears both stale claims and a prior container in-flight deadline', () => {
    const db = getOutboundDb();
    db.prepare("INSERT INTO processing_ack VALUES ('stale', 'processing', ?)").run(new Date().toISOString());
    setContainerToolInFlight('CodexItem', 60 * 60 * 1000);

    clearStaleProcessingAcks();

    expect(db.prepare('SELECT COUNT(*) AS count FROM processing_ack').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT current_tool FROM container_state WHERE id = 1').get()).toEqual({
      current_tool: null,
    });
  });
});

describe('repository mount poll and tool admission barrier', () => {
  const activateBarrier = (epoch: string): void => {
    getInboundDb()
      .prepare("INSERT INTO repo_ingress_fence (id, epoch, generation, state) VALUES (1, ?, ?, 'active')")
      .run(epoch, `generation-${epoch}`);
  };

  it('hides inbound inserted after activation and acknowledges only from the provider-idle poll boundary', () => {
    activateBarrier('repository-publish:req-1');
    insertMessage('late-after-fence', 'chat', { sender: 'Operator', text: 'must wait' });

    expect(getPendingMessages()).toEqual([]);
    expect(
      getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'repository_mount_barrier_ack'").get(),
    ).toBe(null);
    expect(evaluateAdmission()).toBe(true);
    expect(
      getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'repository_mount_barrier_ack'").get(),
    ).toEqual({
      value: JSON.stringify(['repository-publish:req-1', 'generation-repository-publish:req-1']),
    });
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS count FROM processing_ack').get()).toEqual({ count: 0 });
  });

  it('drains an already-open query without claiming late inbound and acknowledges only after it returns', async () => {
    let finishTurn!: () => void;
    const turnFinished = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    let confirmEndRequested!: () => void;
    const endRequested = new Promise<void>((resolve) => {
      confirmEndRequested = resolve;
    });
    let endCalls = 0;
    let pushCalls = 0;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'active-before-fence' };
      await turnFinished;
    }
    const query: AgentQuery = {
      push: () => {
        pushCalls += 1;
      },
      end: () => {
        endCalls += 1;
        confirmEndRequested();
      },
      abort: finishTurn,
      events: events(),
    };
    const activeQuery = processQuery(query, ERR_ROUTING, [], 'claude', undefined, 'already running', undefined, {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    activateBarrier('repository-transfer:req-2');
    insertMessage('late-while-active', 'chat', { sender: 'Operator', text: 'must not start' });
    // A tool belonging to the already-admitted turn remains allowed to finish;
    // query.end is graceful admission close, not an abort or a provider hook
    // denial. The host cannot observe an idle ACK while this query/tool lives.
    const admittedTool = (await preToolUseHook(
      { tool_name: 'Bash', tool_input: { command: 'echo admitted-before-fence', timeout: 30_000 } } as never,
      {} as never,
      {} as never,
    )) as { continue?: boolean; decision?: string };
    expect(admittedTool).toEqual({ continue: true });
    await endRequested;
    expect(getOutboundDb().prepare('SELECT current_tool FROM container_state WHERE id = 1').get()).toEqual({
      current_tool: 'Bash',
    });
    expect(
      getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'repository_mount_barrier_ack'").get(),
    ).toBe(null);
    await postToolUseHook({} as never, {} as never, {} as never);
    finishTurn();

    await activeQuery;
    expect(endCalls).toBe(1);
    expect(pushCalls).toBe(0);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS count FROM processing_ack').get()).toEqual({ count: 0 });
    expect(
      getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'repository_mount_barrier_ack'").get(),
    ).toBe(null);

    // The active-query observer only drains. Exact ACK is deliberately later,
    // after processQuery returned to this provider-idle boundary.
    expect(evaluateAdmission()).toBe(true);
    expect(
      getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'repository_mount_barrier_ack'").get(),
    ).toEqual({
      value: JSON.stringify(['repository-transfer:req-2', 'generation-repository-transfer:req-2']),
    });
  }, 5_000);

  it('requeues a failed admitted batch instead of starting an in-turn recovery after the fence lands', async () => {
    insertMessage('retry-me-after-transition', 'chat', { sender: 'Operator', text: 'preserve this request' });
    let queryCalls = 0;
    let rotationCalls = 0;
    const provider = {
      supportsNativeSlashCommands: false,
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      isRetryable: () => true,
      rotateApiKey: () => {
        rotationCalls += 1;
        return { rotated: true };
      },
      query: () => {
        queryCalls += 1;
        async function* events(): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'failed-before-recovery' };
          activateBarrier('repository-publish:req-recovery');
          throw new Error('retryable upstream failure');
        }
        return { push: () => {}, end: () => {}, abort: () => {}, events: events() };
      },
    };
    const abort = new AbortController();
    const loop = runPollLoop({
      provider: provider as never,
      providerName: 'claude',
      cwd: '/tmp',
      signal: abort.signal,
      autosaveWorktrees: async () => ({ committed: [], failed: [], skipped: [] }),
    });

    const deadline = Date.now() + 3_000;
    while (
      (
        getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'repository_mount_barrier_ack'").get() as
          | { value: string }
          | undefined
      )?.value !== JSON.stringify(['repository-publish:req-recovery', 'generation-repository-publish:req-recovery'])
    ) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for repository barrier acknowledgement');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(queryCalls).toBe(1);
    expect(rotationCalls).toBe(0);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS count FROM processing_ack').get()).toEqual({ count: 0 });
    expect(
      getInboundDb().prepare('SELECT status FROM messages_in WHERE id = ?').get('retry-me-after-transition'),
    ).toEqual({
      status: 'pending',
    });
    abort.abort();
    await loop;
  }, 5_000);

  it('adds retry provenance after credential rotation while preserving the same unfinished task payload', async () => {
    insertMessage('task-occurrence-retry', 'task', { prompt: 'Review the release queue once.' });
    setContinuation('claude', 'retry-provenance-session');
    const queryInputs: Array<{ prompt: string; continuation?: string }> = [];
    let queryCalls = 0;
    const provider = {
      supportsNativeSlashCommands: false,
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      isRetryable: () => true,
      rotateApiKey: () => ({ rotated: true }),
      query: (input: { prompt: string; continuation?: string }) => {
        queryInputs.push(input);
        queryCalls += 1;
        const attempt = queryCalls;
        async function* events(): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'retry-provenance-session' };
          if (attempt === 1) throw new Error('retryable upstream failure');
          yield { type: 'result', text: 'Reviewed the release queue.' };
        }
        return { push: () => {}, end: () => {}, abort: () => {}, events: events() };
      },
    };
    const abort = new AbortController();
    const loop = runPollLoop({
      provider: provider as never,
      providerName: 'claude',
      cwd: '/tmp',
      signal: abort.signal,
      autosaveWorktrees: async () => ({ committed: [], failed: [], skipped: [] }),
    });

    try {
      const deadline = Date.now() + 3_000;
      while (
        (
          getOutboundDb()
            .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
            .get('task-occurrence-retry') as { status: string } | undefined
        )?.status !== 'completed'
      ) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for credential-rotation retry completion');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(queryInputs).toHaveLength(2);
      expect(queryInputs[0].prompt).not.toContain('<runner-retry-provenance>');
      expect(queryInputs[0].continuation).toBe('retry-provenance-session');
      expect(queryInputs[1].continuation).toBe('retry-provenance-session');
      expect(queryInputs[1].prompt).toContain('<runner-retry-provenance>');
      expect(queryInputs[1].prompt).toContain('Task occurrence ID: "task-occurrence-retry".');
      expect(queryInputs[1].prompt).toContain('has not recorded a completed result');
      expect(queryInputs[1].prompt).toContain('inspect durable effects already produced');
      expect(queryInputs[1].prompt.endsWith(queryInputs[0].prompt)).toBe(true);
      expect(
        getOutboundDb().prepare("SELECT COUNT(*) AS count FROM messages_out WHERE kind = 'task_log'").get(),
      ).toEqual({
        count: 1,
      });
    } finally {
      abort.abort();
      await loop;
    }
  }, 5_000);

  // A Claude stream outlives its result (claude.ts ends it only on
  // end()/abort), and a task stream is never ended: ending one closes the CLI's
  // stdin while it may still run a queued turn, and every hook callback on that
  // turn then fails open. So a task fire's outcome is written when its turn
  // reports it. Held for processQuery's return, it died with the container the
  // host reaped first: 12,523 task runs had produced one run-outcome row
  // (2026-09-10). The fakes above close their own generators after `result`,
  // which is what hid this.
  function openAfterResultProvider(
    opts: { failFirst?: Error; turns?: Array<{ text: string | null; answered?: string[] }>; settle?: string[] } = {},
  ) {
    let queryCalls = 0;
    const endedAttempts: number[] = [];
    const releases: Array<() => void> = [];
    const provider = {
      supportsNativeSlashCommands: false,
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      isRetryable: () => true,
      rotateApiKey: () => ({ rotated: true }),
      query: () => {
        queryCalls += 1;
        const attempt = queryCalls;
        let release!: () => void;
        const closed = new Promise<void>((resolve) => (release = resolve));
        releases.push(release);
        async function* events(): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'open-stream-session' };
          if (opts.failFirst && attempt === 1) throw opts.failFirst;
          const turns = opts.turns ?? [{ text: `Finished attempt ${attempt}.` }];
          for (const [i, turn] of turns.entries()) {
            if (i > 0) yield { type: 'init', continuation: 'open-stream-session' };
            yield {
              type: 'result',
              text: turn.text,
              ...(turn.answered === undefined ? {} : { answeredPrompts: turn.answered }),
            };
          }
          if (opts.settle) yield { type: 'settled', unansweredPrompts: opts.settle };
          await closed; // like claude.ts: the stream outlives its result
        }
        // A fake that tracks prompt ids, like claude.ts, when the test gives
        // its results ids.
        const tracksIds = opts.turns?.some((t) => t.answered !== undefined) ?? false;
        let pushes = 0;
        return {
          push: () => (tracksIds ? `p-push-${++pushes}` : undefined),
          ...(tracksIds ? { initialPromptId: 'p-initial' } : {}),
          end: () => {
            endedAttempts.push(attempt);
            release();
          },
          abort: () => release(),
          events: events(),
        };
      },
    };
    // The loop's abort listener is bound to the first query, not to a
    // credential-rotation retry, so aborting the loop leaves a retry stream
    // open. Tests release every stream they opened so no loop outlives them.
    return { provider, endedAttempts, calls: () => queryCalls, releaseAll: () => releases.forEach((r) => r()) };
  }

  const taskLogRowsNow = (): Array<{ text?: string }> =>
    (
      getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as {
        content: string;
      }[]
    ).map((r) => JSON.parse(r.content) as { text?: string });

  async function waitForTaskLog(): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (taskLogRowsNow().length === 0) {
      if (Date.now() >= deadline) throw new Error('no task_log row: the fire outcome was never written');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function startOpenStreamLoop(fake: ReturnType<typeof openAfterResultProvider>) {
    const abort = new AbortController();
    const loop = runPollLoop({
      provider: fake.provider as never,
      providerName: 'claude',
      cwd: '/tmp',
      signal: abort.signal,
      autosaveWorktrees: async () => ({ committed: [], failed: [], skipped: [] }),
    });
    return {
      stop: async () => {
        abort.abort();
        fake.releaseAll();
        await loop;
      },
    };
  }

  it('records a task fire outcome while the provider stream stays open after its result', async () => {
    insertMessage('task-open-stream', 'task', { prompt: 'Summarise the release queue once.' });
    const fake = openAfterResultProvider();
    const run = startOpenStreamLoop(fake);
    try {
      await waitForTaskLog();
      // Written without ending the stream: it may still run a turn.
      expect(fake.endedAttempts).toEqual([]);
    } finally {
      await run.stop();
    }
    // Checked after the loop's own `finally` ran: still exactly one record.
    expect(taskLogRowsNow().map((r) => r.text)).toEqual(['Finished attempt 1.']);
  }, 5_000);

  it('records one outcome for a fire rescued by credential rotation while the retry stream stays open', async () => {
    insertMessage('task-open-stream-rotated', 'task', { prompt: 'Summarise the release queue once.' });
    const fake = openAfterResultProvider({
      failFirst: new Error("subscription_quota_exhausted: You've hit your weekly limit"),
    });
    const run = startOpenStreamLoop(fake);
    try {
      await waitForTaskLog();
      expect(fake.calls()).toBe(2);
      // The stream that ran the fire is never ended.
      expect(fake.endedAttempts).not.toContain(2);
    } finally {
      await run.stop();
    }
    expect(taskLogRowsNow().map((r) => r.text)).toEqual(['Finished attempt 2.']);
  }, 5_000);

  it("records the task's turn, not the CLI's synthetic resume turn that answers first", async () => {
    // Resuming an interrupted session, the CLI first answers its own "Continue
    // from where you left off." turn, then runs the queued task prompt as a
    // second turn. Only the second consumed a runner prompt (#606).
    insertMessage('task-resumed', 'task', { prompt: 'Summarise the release queue once.' });
    const fake = openAfterResultProvider({
      turns: [
        { text: null, answered: [] },
        { text: 'Queue summarised.', answered: ['p-initial'] },
      ],
    });
    const run = startOpenStreamLoop(fake);
    try {
      await waitForTaskLog();
      expect(fake.endedAttempts).toEqual([]);
    } finally {
      await run.stop();
    }
    expect(taskLogRowsNow().map((r) => r.text)).toEqual(['Queue summarised.']);
  }, 5_000);

  it('records an outcome whose echo was dropped once the provider settles it at idle', async () => {
    // The turn that consumed the task prompt carried no echo (the SDK lists
    // when: a batch led by a meta prompt, a zeroed result). The provider
    // settles the prompt at the CLI's idle, and that turn's result is the
    // fire's outcome.
    insertMessage('task-no-echo', 'task', { prompt: 'Summarise the release queue once.' });
    const fake = openAfterResultProvider({
      turns: [{ text: 'Answered without an echo.', answered: [] }],
      settle: ['p-initial'],
    });
    const run = startOpenStreamLoop(fake);
    try {
      await waitForTaskLog();
      expect(fake.endedAttempts).toEqual([]);
    } finally {
      await run.stop();
    }
    expect(taskLogRowsNow().map((r) => r.text)).toEqual(['Answered without an echo.']);
  }, 5_000);

  it('retries an outcome write that failed, and still writes exactly one record', async () => {
    // The outbound insert is its own transaction, so a write that throws
    // committed nothing and the same outcome can be written again.
    insertMessage('task-write-retry', 'task', { prompt: 'Summarise the release queue once.' });
    const operations = getAgentMailbox().operations;
    const write = operations.writeMessageOut.bind(operations);
    let failed = 0;
    const spy = spyOn(operations, 'writeMessageOut').mockImplementation(async (message) => {
      if (message.kind === 'task_log' && failed === 0) {
        failed += 1;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return write(message);
    });
    const fake = openAfterResultProvider();
    const run = startOpenStreamLoop(fake);
    try {
      await waitForTaskLog();
    } finally {
      await run.stop();
      spy.mockRestore();
    }
    expect(failed).toBe(1);
    expect(taskLogRowsNow().map((r) => r.text)).toEqual(['Finished attempt 1.']);
  }, 5_000);

  // R-8 (plan §8): the outer loop consults the admission seam, not the fence
  // directly. A registered gate that holds must stop dispatch entirely — no
  // claim, no provider call — and releasing it must let the same pending row
  // through.
  it('poll loop skips dispatch while admission is held and resumes when released', async () => {
    insertMessage('held-until-admitted', 'chat', { sender: 'Operator', text: 'wait for admission' });

    let holding = true;
    let gateCalls = 0;
    registerAdmissionGate(() => {
      gateCalls += 1;
      return holding;
    });

    let queryCalls = 0;
    const provider = {
      supportsNativeSlashCommands: false,
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      isRetryable: () => false,
      query: () => {
        queryCalls += 1;
        async function* events(): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'admitted-after-release' };
          yield { type: 'result', text: 'admitted' };
        }
        return { push: () => {}, end: () => {}, abort: () => {}, events: events() };
      },
    };

    const abort = new AbortController();
    const loop = runPollLoop({
      provider: provider as never,
      providerName: 'claude',
      cwd: '/tmp',
      signal: abort.signal,
      autosaveWorktrees: async () => ({ committed: [], failed: [], skipped: [] }),
    });

    try {
      // Two held ticks: the gate is consulted each second and dispatch never starts.
      const holdDeadline = Date.now() + 4_000;
      while (gateCalls < 2) {
        if (Date.now() >= holdDeadline) throw new Error('timed out waiting for two held poll ticks');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(queryCalls).toBe(0);
      expect(getOutboundDb().prepare('SELECT COUNT(*) AS count FROM processing_ack').get()).toEqual({ count: 0 });

      holding = false;
      const releaseDeadline = Date.now() + 4_000;
      while (
        (
          getOutboundDb()
            .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
            .get('held-until-admitted') as { status: string } | undefined
        )?.status === undefined
      ) {
        if (Date.now() >= releaseDeadline)
          throw new Error('timed out waiting for the released message to be processed');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(queryCalls).toBe(1);
    } finally {
      holding = false;
      abort.abort();
      await loop;
    }
  }, 15_000);
});

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('native slash command thread context', () => {
  it('keeps the router-provided transcript when dispatching a native command', () => {
    insertMessage('threaded-wwbd', 'chat-sdk', {
      sender: 'Operator',
      text:
        '[Thread context]\n' +
        'Decision bot: Chain consent: which rule should the save drawer mirror?\n' +
        'Option A mirrors the chain enforcer; Option B mirrors market scope.\n' +
        '[Latest message]\n' +
        '<@U_DECISION_BOT> /wwbd ?',
    });

    const prompt = formatMessagesWithCommands(getPendingMessages(), true);
    expect(prompt.startsWith('/wwbd ?\n\n')).toBe(true);
    expect(prompt).toContain('Chain consent: which rule should the save drawer mirror?');
    expect(prompt).not.toContain('<message');
  });

  it('keeps a native command ahead of its host-inserted recall companion', () => {
    // Channel ingress commits recall_context first and its trigger second
    // (src/modules/mailbox/ops/ingress.ts:94-110). Preserve that production
    // sequence exactly: native Claude commands only dispatch when their raw
    // slash token is the first bytes handed to the SDK.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?)`,
      )
      .run(
        'recall-threaded-wwbd-with-recall',
        2,
        'system',
        0,
        JSON.stringify({ subtype: 'recall_context', text: 'The response card asks about the save drawer.' }),
      );
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?)`,
      )
      .run(
        'threaded-wwbd-with-recall',
        4,
        'chat-sdk',
        1,
        JSON.stringify({ sender: 'Operator', text: '<@U_DECISION_BOT> /wwbd ?' }),
      );

    const pair = getPendingMessages();
    expect(pair.map((message) => message.id)).toEqual([
      'recall-threaded-wwbd-with-recall',
      'threaded-wwbd-with-recall',
    ]);

    const prompt = formatMessagesWithCommands(pair, true);
    expect(prompt.startsWith('/wwbd ?')).toBe(true);
    expect(prompt).toContain('The response card asks about the save drawer.');
    expect(prompt.indexOf('[Untrusted recalled evidence')).toBeGreaterThan(0);
  });

  it('keeps a native command first after cold continuation rotation bootstraps a recalled turn', async () => {
    // A rotating continuation forces runner-side bootstrap after host recall
    // already committed its context/trigger pair (poll-loop.ts:389-403, 690-715).
    setContinuation('claude', 'continuation-that-must-rotate');
    insertMessage(
      'recall-rotated-wwbd',
      'system',
      { subtype: 'recall_context', text: 'The response card asks about the save drawer.' },
      { trigger: 0 },
    );
    insertMessage(
      'rotated-wwbd',
      'chat-sdk',
      { sender: 'Operator', text: '<@U_DECISION_BOT> /wwbd ?' },
      { trigger: 1 },
    );

    const prompts: string[] = [];
    const provider = {
      supportsNativeSlashCommands: true,
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      isRetryable: () => false,
      maybeRotateContinuation: (continuation: string) =>
        continuation === 'continuation-that-must-rotate' ? 'fixture rotation' : null,
      query: ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        async function* events(): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'fresh-after-rotation' };
          yield { type: 'result', text: '<internal>done</internal>' };
        }
        return { push: () => {}, end: () => {}, abort: () => {}, events: events() };
      },
    };
    const abort = new AbortController();
    const loop = runPollLoop({
      provider: provider as never,
      providerName: 'claude',
      cwd: '/tmp',
      signal: abort.signal,
      autosaveWorktrees: async () => ({ committed: [], failed: [], skipped: [] }),
    });

    try {
      const deadline = Date.now() + 3_000;
      while (prompts.length === 0) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for rotated native-command prompt');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(prompts[0]?.startsWith('/wwbd ?')).toBe(true);
      expect(prompts[0]).toContain('The response card asks about the save drawer.');
      expect(prompts[0]?.indexOf('runner-fresh-context-bootstrap')).toBeGreaterThan(0);
    } finally {
      abort.abort();
      await loop;
    }
  }, 5_000);
});

describe('chat budget from task content', () => {
  // The budget is a process-global in db/messages-out.ts and bun runs every
  // test file in one process. Reset it here, not at the end of a test body: a
  // failing expect above would otherwise leave it exhausted and silently drop
  // every later kind:'chat' write in the whole run — which looks exactly like
  // the unrelated "expected length 1, received 0" failures.
  afterEach(() => {
    const { setChatLimit } = require('./modules/mailbox/index.js');
    setChatLimit(null);
  });

  it('muteChat zeroes the budget; chatLimit sets it; absent leaves unlimited', () => {
    const { isChatMuted } = require('./modules/mailbox/index.js');
    insertMessage('t-mute', 'task', { prompt: 'watch', muteChat: true });
    let messages = getPendingMessages().filter((m) => m.id === 't-mute');
    applyChatBudget(messages);
    expect(isChatMuted()).toBe(true);

    insertMessage('t-lim', 'task', { prompt: 'standup', chatLimit: 1 });
    messages = getPendingMessages().filter((m) => m.id === 't-lim');
    applyChatBudget(messages);
    expect(isChatMuted()).toBe(false); // budget 1, not muted

    insertMessage('t-plain', 'task', { prompt: 'normal' });
    messages = getPendingMessages().filter((m) => m.id === 't-plain');
    applyChatBudget(messages);
    expect(isChatMuted()).toBe(false);
  });

  it('mid-turn applyFlagBatch does not clear an active budget', () => {
    // Regression: a deferred recall row arriving mid-turn hit the settings
    // re-check path (applyFlagBatch with no task rows) and un-muted a muted
    // task turn — observed live 2026-08-02.
    const { isChatMuted } = require('./modules/mailbox/index.js');
    insertMessage('t-mute-2', 'task', { prompt: 'watch', muteChat: true });
    let messages = getPendingMessages().filter((m) => m.id === 't-mute-2');
    applyChatBudget(messages);
    expect(isChatMuted()).toBe(true);

    insertMessage('mid-turn-chat', 'chat', { sender: 'Operator', text: 'hi' });
    messages = getPendingMessages().filter((m) => m.id === 'mid-turn-chat');
    applyFlagBatch(messages, extractRouting(messages), 'claude');
    expect(isChatMuted()).toBe(true); // still muted

    applyChatBudget([]); // next turn boundary resets
    expect(isChatMuted()).toBe(false);
  });

  it('budget counts new posts only — edits and reactions stay allowed after exhaustion', async () => {
    const { setChatLimit, chatBudgetExhausted } = require('./modules/mailbox/index.js');
    const { writeMessageOut } = require('./db/messages-out.js');
    setChatLimit(1);
    expect(chatBudgetExhausted()).toBe(false);

    const first = await writeMessageOut({ id: 'b-post-1', kind: 'chat', content: JSON.stringify({ text: 'digest' }) });
    expect(first).toBeGreaterThan(0);
    expect(chatBudgetExhausted()).toBe(true);

    const second = await writeMessageOut({
      id: 'b-post-2',
      kind: 'chat',
      content: JSON.stringify({ text: 'follow-up summary' }),
    });
    expect(second).toBe(-1);

    const edit = await writeMessageOut({
      id: 'b-edit-1',
      kind: 'chat',
      content: JSON.stringify({ operation: 'edit', messageId: 'x', text: 'digest v2' }),
    });
    expect(edit).toBeGreaterThan(0);
  });
});

describe('fast-mode flag application', () => {
  it('persists sticky Codex on/off and honors one-turn precedence', () => {
    insertMessage('m1', 'chat', { sender: 'Operator', text: 'hi', flagIntent: { stickyFast: true } });
    const messages = getPendingMessages();
    const routing = extractRouting(messages);

    expect(applyFlagBatch(messages, routing, 'codex').fast).toBe(true);
    expect(applyFlagBatch([], routing, 'codex').fast).toBe(true);

    insertMessage('m2', 'chat', { sender: 'Operator', text: 'standard once', flagIntent: { turnFast: false } });
    const oneTurn = getPendingMessages().filter((m) => m.id === 'm2');
    expect(applyFlagBatch(oneTurn, routing, 'codex').fast).toBe(false);
    expect(applyFlagBatch([], routing, 'codex').fast).toBe(true);

    insertMessage('m3', 'chat', { sender: 'Operator', text: 'standard', flagIntent: { stickyFast: false } });
    const stickyOff = getPendingMessages().filter((m) => m.id === 'm3');
    expect(applyFlagBatch(stickyOff, routing, 'codex').fast).toBe(false);
    expect(applyFlagBatch([], routing, 'codex').fast).toBe(false);
  });

  it('does not apply a preserved Codex sticky to another provider', () => {
    insertMessage('m1', 'chat', { sender: 'Operator', text: 'hi', flagIntent: { stickyFast: true } });
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(applyFlagBatch(messages, routing, 'codex').fast).toBe(true);
    expect(applyFlagBatch([], routing, 'claude').fast).toBe(false);
    expect(applyFlagBatch([], routing, 'opencode').fast).toBe(false);
  });
});

describe('model pin under a provider fallback', () => {
  it('ignores a sticky model that belongs to another provider, keeps it stored, and reports it once', () => {
    // Observed live 2026-09-16: `-m astra` pinned gpt-6-astra on a codex
    // session; codex parked; the claude fallback container read the sticky
    // and asked the Anthropic API for gpt-6-astra on every turn.
    insertMessage('m1', 'chat', { sender: 'Operator', text: 'hi', flagIntent: { stickyModel: 'gpt-6-astra' } });
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(applyFlagBatch(messages, routing, 'codex')).toMatchObject({ model: 'gpt-6-astra' });

    const onClaude = applyFlagBatch([], routing, 'claude');
    expect(onClaude.model).toBeUndefined();
    expect(onClaude.ignoredModel).toBe('gpt-6-astra');
    expect(applyFlagBatch([], routing, 'opencode').model).toBeUndefined();

    // The sticky survives the fallback: the primary gets it back verbatim.
    expect(applyFlagBatch([], routing, 'codex')).toMatchObject({ model: 'gpt-6-astra' });
    expect('ignoredModel' in applyFlagBatch([], routing, 'codex')).toBe(false);
  });

  it('a one-turn model flag is dropped the same way', () => {
    insertMessage('m1', 'chat', { sender: 'Operator', text: 'once', flagIntent: { turnModel: 'claude-opus-5[1m]' } });
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(applyFlagBatch(messages, routing, 'codex')).toMatchObject({ ignoredModel: 'claude-opus-5[1m]' });
    expect(applyFlagBatch(messages, routing, 'claude')).toMatchObject({ model: 'claude-opus-5[1m]' });
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('keeps a due deferred wake invisible when a warm container sees concurrent real inbound', () => {
    insertMessage('schedule-wake-1', 'chat', { text: '[system] check CI' }, { trigger: 0 });
    insertMessage('recall-schedule-wake-1', 'system', { subtype: 'recall_context', deferred: true }, { trigger: 0 });
    insertMessage('m1', 'chat', { sender: 'A', text: 'new user turn' }, { trigger: 1 });

    expect(getPendingMessages().map((m) => m.id)).toEqual(['m1']);
  });

  it('keeps a due deferred on-wake pair invisible on a concurrent fresh-container turn', () => {
    insertMessage(
      'host-restart-1',
      'chat',
      { text: '[system] account for interrupted work' },
      { trigger: 0, onWake: 1 },
    );
    insertMessage(
      'recall-host-restart-1',
      'system',
      { subtype: 'recall_context', deferred: true },
      { trigger: 0, onWake: 1 },
    );
    insertMessage('m1', 'chat', { sender: 'A', text: 'new user turn' }, { trigger: 1 });

    expect(getPendingMessages(true).map((m) => m.id)).toEqual(['m1']);
    markCompleted(['m1']);

    // Simulate host due-admission after that first poll. Admission replaces
    // the marker, enables the trigger, and clears on_wake on both halves so
    // this already-running fresh container can consume the accountability turn.
    getInboundDb()
      .prepare('UPDATE messages_in SET content = ?, on_wake = 0 WHERE id = ?')
      .run(JSON.stringify({ subtype: 'recall_context', trustedCapabilities: {} }), 'recall-host-restart-1');
    getInboundDb().prepare('UPDATE messages_in SET trigger = 1, on_wake = 0 WHERE id = ?').run('host-restart-1');

    expect(
      getPendingMessages(false)
        .map((m) => m.id)
        .sort(),
    ).toEqual(['host-restart-1', 'recall-host-restart-1']);
  });

  it('selectInTurnFollowUps: pure trigger=0 batch defers (no push)', () => {
    // The agent is mid-stream on an earlier turn — a non-mention shouldn't
    // interrupt thinking-blocks with content the bot wasn't addressed in.
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise during active turn' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'C', text: 'more noise' }, { trigger: 0 });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);
  });

  it('selectInTurnFollowUps: trigger=0 chat rides along when batch contains a chat trigger=1', () => {
    // Warm-container regression: prior implementation dropped trigger=0
    // unconditionally in the in-turn filter, stranding accumulated context
    // whenever the next mention also arrived in-turn (long-lived container
    // that never cold-restarts). Agent saw the mention but lost prior context.
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier non-mention' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'mid-turn mention' }, { trigger: 1 });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('selectInTurnFollowUps: /clear is not a real trigger — does not unlock trigger=0 ride-along', () => {
    // /clear is trigger=1 but excluded later in the loop (resets the
    // session). It must not gate trigger=0 context into the prompt — the
    // prompt would render only the context block and the /clear would be
    // handled separately. Defer until a real trigger arrives.
    insertMessage('m1', 'chat', { sender: 'A', text: 'old non-mention' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: '/clear' }, { trigger: 1 });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);
  });

  it('selectInTurnFollowUps: non-recall system row trigger=1 does not unlock trigger=0', () => {
    // System rows (other than recall_context) are dropped by the filter —
    // they should not gate trigger=0 ride-along either.
    insertMessage('m1', 'chat', { sender: 'A', text: 'context' }, { trigger: 0 });
    insertMessage('s1', 'system', { subtype: 'something_else' }, { trigger: 1 });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);
  });

  it('selectInTurnFollowUps: trigger=0 task rows do NOT ride along — only chat/chat-sdk do', () => {
    // The original `m.trigger !== 1` guard rejected trigger=0 of any kind.
    // The new ride-along is restricted to chat/chat-sdk; tasks and webhooks
    // still gate on their own trigger=1.
    insertMessage('m1', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });
    insertMessage('t1', 'task', { script: 'noop', wakeAgent: false }, { trigger: 0 });
    const ids = selectInTurnFollowUps(getPendingMessages()).map((m) => m.id);
    expect(ids).toEqual(['m1']);
  });

  it('selectInTurnFollowUps: chat-sdk parity — trigger=0 chat-sdk rides along like chat', () => {
    insertMessage('m1', 'chat-sdk', { sender: 'A', text: 'context' }, { trigger: 0 });
    insertMessage('m2', 'chat-sdk', { sender: 'B', text: 'mention' }, { trigger: 1 });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('selectInTurnFollowUps: trigger=0 webhook does NOT ride — only chat/chat-sdk do', () => {
    insertMessage('m1', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });
    insertMessage('w1', 'webhook', { url: '/x' }, { trigger: 0 });
    const ids = selectInTurnFollowUps(getPendingMessages()).map((m) => m.id);
    expect(ids).toEqual(['m1']);
  });

  it('selectInTurnFollowUps: malformed recall content/id is dropped, not crashed on', () => {
    insertMessage('m1', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });
    // Not JSON
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
         VALUES ('s-bad', 'system', datetime('now'), 'pending', 0, 'not-json')`,
      )
      .run();
    // Recall-shaped but no recall- prefix
    insertMessage('s-noprefix', 'system', { subtype: 'recall_context', text: 'x' }, { trigger: 0 });
    const ids = selectInTurnFollowUps(getPendingMessages()).map((m) => m.id);
    expect(ids).toEqual(['m1']);
  });

  it('selectInTurnFollowUps: /clear alongside a real mention — /clear excluded, real batch admitted', () => {
    insertMessage('clr', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('ctx', 'chat', { sender: 'B', text: 'old context' }, { trigger: 0 });
    insertMessage('real', 'chat', { sender: 'C', text: 'hey @bot' }, { trigger: 1 });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    // /clear stays out; the real batch (real + ctx) goes through.
    expect(ids).toEqual(['ctx', 'real']);
  });

  it('isAdmissibleTrigger: returns true only for non-system, non-/clear, trigger=1 rows', () => {
    insertMessage('a', 'chat', { sender: 'A', text: 'hi' }, { trigger: 1 });
    insertMessage('b', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('c', 'chat', { sender: 'A', text: 'ctx' }, { trigger: 0 });
    insertMessage('d', 'system', { subtype: 'something' }, { trigger: 1 });
    insertMessage('e', 'task', { name: 'cron' }, { trigger: 1 });
    const byId = Object.fromEntries(getPendingMessages().map((m) => [m.id, m]));
    expect(isAdmissibleTrigger(byId.a)).toBe(true);
    expect(isAdmissibleTrigger(byId.b)).toBe(false);
    expect(isAdmissibleTrigger(byId.c)).toBe(false);
    expect(isAdmissibleTrigger(byId.d)).toBe(false);
    expect(isAdmissibleTrigger(byId.e)).toBe(true);
  });

  it('selectInTurnFollowUps: recall_context only rides when paired trigger is admitted', () => {
    // Pair admission must be checked against the post-filter trigger set,
    // not the raw snapshot. /clear's id should NOT satisfy a recall pair.
    insertMessage('clear-id', 'chat', { sender: 'B', text: '/clear' }, { trigger: 1 });
    insertMessage(
      'recall-clear-id',
      'system',
      { subtype: 'recall_context', text: 'facts' },
      {
        trigger: 0,
      },
    );
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);

    // But a recall paired with a real trigger does ride along.
    insertMessage('real-mention', 'chat', { sender: 'B', text: 'hey @bot' }, { trigger: 1 });
    insertMessage(
      'recall-real-mention',
      'system',
      { subtype: 'recall_context', text: 'facts' },
      {
        trigger: 0,
      },
    );
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['real-mention', 'recall-real-mention']);
  });

  it('getPendingMessages: orphan recall-X is dropped when paired trigger X is in processing_ack', () => {
    // The host writes recall-X paired to inbound row X. If X is a /clear
    // (handled and markCompleted'd inline by the runner) or a task gated
    // by pre-task script, X gets a 'completed' processing_ack but recall-X
    // never does. Without the orphan drain, recall-X would surface as a
    // standalone structured recall payload with no user message on the
    // next cold-start iteration.
    insertMessage('X', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    insertMessage('Y', 'chat', { sender: 'B', text: 'hey @bot' }, { trigger: 1 });
    // Simulate X being completed (as the /clear handler would do).
    markCompleted(['X']);
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    // recall-X must be gone; Y is still pending.
    expect(ids).toEqual(['Y']);
  });

  it('getPendingMessages: orphan recall-X is dropped when paired trigger X has a messages_out reply', () => {
    // The respondedIds idempotency guard treats X as completed if the
    // agent already wrote a reply. recall-X must drain on this signal too.
    insertMessage('X', 'chat', { sender: 'A', text: 'old mention' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    getInboundDb()
      // Use raw INSERT so we don't trigger the markCompleted helper here.
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
         VALUES ('Y', 'chat', datetime('now'), 'pending', 1, '{"text":"hi"}')`,
      )
      .run();
    // Simulate the agent having replied to X already.
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('out-1', 'chat', datetime('now'), 'X', '{"text":"replied"}')`,
      )
      .run();
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['Y']);
  });

  it('getPendingMessages: status-only output does not hide a pending turn after restart', () => {
    // A restart between progress delivery and the final answer leaves status
    // rows in messages_out but the inbound trigger still pending. Those status
    // rows are not a response; the replacement container must retry X with its
    // paired recall context instead of polling "0 pending" forever.
    insertMessage('X', 'chat-sdk', { sender: 'A', text: 'hey @bot' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('status-1', 'status', datetime('now'), 'X', '{"text":"thinking"}')`,
      )
      .run();
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['X', 'recall-X']);
  });

  it('getPendingMessages: due task row survives a phantom reply written BEFORE it was due (poison guard)', () => {
    // Regression for the 2026-05-27..31 scheduled-task die-off: a sibling
    // task's output was stamped in_reply_to = this row's id hours before
    // this row's process_after. A reply can't precede its question — the
    // row must still fire.
    const dueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // due 1h ago
    insertMessage('t-next', 'task', { prompt: 'daily briefing' }, { processAfter: dueAt });
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('phantom', 'chat', datetime('now', '-3 hours'), 't-next', '{"text":"sibling task output"}')`,
      )
      .run();
    const ids = getPendingMessages().map((m) => m.id);
    expect(ids).toEqual(['t-next']);
  });

  it('getPendingMessages: task row IS filtered when the reply came after it was due (crash-dup protection)', () => {
    // The original guard's purpose: container died between writing the
    // reply and markCompleted. Reply timestamp >= process_after means the
    // row genuinely ran — don't re-process it.
    const dueAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // due 2h ago
    insertMessage('t-ran', 'task', { prompt: 'daily briefing' }, { processAfter: dueAt });
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('real-reply', 'chat', datetime('now', '-1 hour'), 't-ran', '{"text":"briefing output"}')`,
      )
      .run();
    expect(getPendingMessages().map((m) => m.id)).toEqual([]);
  });

  it('getPendingMessages: due-aware guard handles SQLite-format process_after (retryWithBackoff shape)', () => {
    // process_after can be ISO (scheduleTask) or 'YYYY-MM-DD HH:MM:SS'
    // (datetime-based backoff). Both must compare correctly as UTC.
    insertMessage('t-backoff', 'task', { prompt: 'retry me' }, { processAfter: '2026-01-01 00:00:00' });
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('late-reply', 'chat', datetime('now'), 't-backoff', '{"text":"done"}')`,
      )
      .run();
    // Reply (now) is after due (2026-01-01) → genuinely handled → filtered.
    expect(getPendingMessages().map((m) => m.id)).toEqual([]);
  });

  it('getPendingMessages: stale recall ack from before retry admission does not hide the rebuilt pair', () => {
    const dueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    insertMessage('retry-X', 'chat-sdk', { text: 'retry with fresh memory' }, { trigger: 1, processAfter: dueAt });
    insertMessage(
      'recall-retry-X',
      'system',
      { subtype: 'recall_context', memoryEvidence: { core: [], excerpts: [] } },
      { trigger: 0, processAfter: dueAt },
    );
    getOutboundDb()
      .prepare(
        `INSERT INTO processing_ack (message_id, status, status_changed)
         VALUES ('recall-retry-X', 'completed', datetime('now', '-2 hours'))`,
      )
      .run();

    expect(
      getPendingMessages()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['recall-retry-X', 'retry-X']);
  });

  it('getPendingMessages: legitimate paired recall-X + X both still returned (no false positive drain)', () => {
    // The drain only fires when X is acked or replied-to. A normal pair
    // with both rows still pending must come through untouched.
    insertMessage('X', 'chat', { sender: 'B', text: 'hey @bot' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['X', 'recall-X']);
  });

  it('drops an unpaired admissible trigger from a memory-enabled cold and warm batch', () => {
    insertMessage('paired', 'chat', { sender: 'B', text: 'paired mention' }, { trigger: 1 });
    insertMessage('recall-paired', 'system', { subtype: 'recall_context', text: 'current facts' }, { trigger: 0 });
    insertMessage('half-pair', 'chat', { sender: 'C', text: 'missing context' }, { trigger: 1 });

    const raw = getInboundDb().prepare('SELECT * FROM messages_in ORDER BY rowid').all() as any[];
    expect(
      selectInTurnFollowUps(raw)
        .map((row) => row.id)
        .sort(),
    ).toEqual(['paired', 'recall-paired']);

    const cold = getPendingMessages();
    expect(cold.map((row) => row.id).sort()).toEqual(['paired', 'recall-paired']);
  });

  it('fails closed on a wholly unpaired batch in a trusted workgroup runtime', () => {
    const priorWorkgroupId = process.env.NANOCLAW_WORKGROUP_ID;
    process.env.NANOCLAW_WORKGROUP_ID = 'alpha';
    try {
      insertMessage('half-pair', 'chat', { sender: 'C', text: 'missing context' }, { trigger: 1 });
      const raw = getInboundDb().prepare('SELECT * FROM messages_in ORDER BY rowid').all() as any[];
      expect(selectInTurnFollowUps(raw)).toEqual([]);
      expect(getPendingMessages()).toEqual([]);
    } finally {
      if (priorWorkgroupId === undefined) delete process.env.NANOCLAW_WORKGROUP_ID;
      else process.env.NANOCLAW_WORKGROUP_ID = priorWorkgroupId;
    }
  });

  it('test_limit_boundary_returns_complete_newest_pairs', () => {
    for (let i = 1; i <= 11; i++) {
      insertMessage(`m-${i}`, 'chat', { sender: 'B', text: `mention ${i}` }, { trigger: 1 });
      insertMessage(`recall-m-${i}`, 'system', { subtype: 'recall_context', text: `facts ${i}` }, { trigger: 0 });
    }

    const ids = getPendingMessages().map((m) => m.id);

    expect(ids).toHaveLength(20);
    expect(ids).not.toContain('m-1');
    expect(ids).not.toContain('recall-m-1');
    for (let i = 2; i <= 11; i++) {
      expect(ids).toContain(`m-${i}`);
      expect(ids).toContain(`recall-m-${i}`);
    }
    expect(selectInTurnFollowUps(getPendingMessages()).map((m) => m.id)).toEqual(ids);
  });

  it('retains the sole fresh-context bootstrap pair beyond the newest-unit limit', () => {
    insertMessage('bootstrap', 'chat', { sender: 'B', text: 'oldest mention' }, { trigger: 1 });
    insertMessage(
      'recall-bootstrap',
      'system',
      {
        subtype: 'recall_context',
        trustedCapabilities: { agentGroupId: 'agent-a', services: [] },
        memoryEvidence: { core: [], excerpts: [] },
        conversationEvidence: { excerpts: [] },
        notices: [],
      },
      { trigger: 0 },
    );
    for (let i = 1; i <= 11; i++) {
      insertMessage(`m-${i}`, 'chat', { sender: 'B', text: `mention ${i}` }, { trigger: 1 });
      insertMessage(`recall-m-${i}`, 'system', { subtype: 'recall_context', text: `facts ${i}` }, { trigger: 0 });
    }

    const ids = getPendingMessages().map((row) => row.id);

    expect(ids).toContain('bootstrap');
    expect(ids).toContain('recall-bootstrap');
    expect(ids).toHaveLength(20);
  });

  it('retains a deferred bootstrap pair when a newer wake competes with an over-limit trigger-zero tail', () => {
    insertMessage('bootstrap-deferred', 'chat', { sender: 'B', text: 'retry after reset' }, { trigger: 0 });
    insertMessage(
      'recall-bootstrap-deferred',
      'system',
      {
        subtype: 'recall_context',
        trustedCapabilities: { agentGroupId: 'agent-a', services: [] },
        memoryEvidence: { core: [], excerpts: [] },
        conversationEvidence: { excerpts: [] },
        notices: [],
      },
      { trigger: 0 },
    );
    insertMessage('wake', 'chat', { sender: 'B', text: 'new wake' }, { trigger: 1 });
    insertMessage('recall-wake', 'system', { subtype: 'recall_context', text: 'wake facts' }, { trigger: 0 });
    for (let i = 1; i <= 11; i++) {
      insertMessage(`context-${i}`, 'chat', { sender: 'B', text: `context ${i}` }, { trigger: 0 });
    }

    const ids = getPendingMessages().map((row) => row.id);

    expect(ids).toContain('bootstrap-deferred');
    expect(ids).toContain('recall-bootstrap-deferred');
    expect(ids).toContain('wake');
    expect(ids).toContain('recall-wake');
  });

  it('test_completed_trigger_drains_orphan_without_hiding_next_pair', () => {
    for (let i = 1; i <= 10; i++) {
      insertMessage(`m-${i}`, 'chat', { sender: 'B', text: `mention ${i}` }, { trigger: 1 });
      insertMessage(`recall-m-${i}`, 'system', { subtype: 'recall_context', text: `facts ${i}` }, { trigger: 0 });
    }
    insertMessage('completed', 'chat', { sender: 'B', text: '/clear' }, { trigger: 1 });
    insertMessage('recall-completed', 'system', { subtype: 'recall_context', text: 'stale facts' }, { trigger: 0 });
    markCompleted(['completed']);

    const ids = getPendingMessages().map((m) => m.id);

    expect(ids).toHaveLength(20);
    expect(ids).not.toContain('completed');
    expect(ids).not.toContain('recall-completed');
    for (let i = 1; i <= 10; i++) {
      expect(ids).toContain(`m-${i}`);
      expect(ids).toContain(`recall-m-${i}`);
    }
  });

  it('drops a recall when command or script admission removes its target but preserves other pairs', () => {
    insertMessage('clear', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('recall-clear', 'system', { subtype: 'recall_context', text: 'old' }, { trigger: 0 });
    insertMessage('real', 'chat', { sender: 'B', text: 'hello' }, { trigger: 1 });
    insertMessage('recall-real', 'system', { subtype: 'recall_context', text: 'current' }, { trigger: 0 });
    const original = getPendingMessages();
    const admitted = original.filter((row) => row.id !== 'clear');

    expect(
      retainCompleteRecallPairs(original, admitted)
        .map((row) => row.id)
        .sort(),
    ).toEqual(['real', 'recall-real']);
  });

  it('bounds inbound candidates without letting a large trigger-zero tail suppress an older due pair', () => {
    insertMessage('due-task', 'task', { prompt: 'run now' }, { trigger: 1 });
    insertMessage('recall-due-task', 'system', { subtype: 'recall_context', text: 'task facts' }, { trigger: 0 });
    for (let i = 0; i < 5_000; i++) {
      insertMessage(`context-${i}`, 'chat', { sender: 'A', text: `context ${i}` }, { trigger: 0 });
    }

    const diagnostics = { inboundRowsRead: 0, inboundRowBudget: 0 };
    const messages = getPendingMessagesWithDiagnostics(false, diagnostics);
    const ids = messages.map((row) => row.id);

    expect(messages).toHaveLength(11);
    expect(ids).toContain('due-task');
    expect(ids).toContain('recall-due-task');
    expect(messages.some((row) => row.trigger === 1)).toBe(true);
    expect(ids.indexOf('due-task')).toBeLessThan(ids.indexOf('context-4999'));
    expect(diagnostics.inboundRowsRead).toBeGreaterThan(0);
    expect(diagnostics.inboundRowsRead).toBeLessThanOrEqual(diagnostics.inboundRowBudget);
    expect(diagnostics.inboundRowBudget).toBeLessThan(200);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  function seedSessionRouting(channelType: string, platformId: string, threadId: string): void {
    const db = getInboundDb();
    db.prepare(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY,
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT
       )`,
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, ?, ?, ?)`,
    ).run(channelType, platformId, threadId);
  }

  function insertInternalAgentNotification(id: string, agentGroupId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, 'agent', NULL, ?)`,
      )
      .run(
        id,
        agentGroupId,
        JSON.stringify({ text: 'Your approval request was rejected.', sender: 'system', senderId: 'system' }),
      );
  }

  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });

  it('marks a batch of only agent_scheduled_wake rows as selfWake, and dispatch drops its bare text', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('schedule-wake-1', 'chat', datetime('now'), 'pending', 'chan-123', 'slack-x', NULL,
               '{"text":"[system] check CI","sender":"system","senderId":"system","_system":{"kind":"agent_scheduled_wake"}}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.selfWake).toBe(true);
    expect(routing.taskRun).toBe(false);

    // The spam shape: bare narration on a wake turn must be logged, not
    // origin-fallback-delivered, and must not trigger the wrap nudge.
    const result = await dispatchResultText('Nothing moved. No post. Next check at 14:36 ET.', routing);
    expect(result.sent).toBe(0);
    expect(result.hasUnwrapped).toBe(false);

    // A mixed batch (wake + real user message) is NOT selfWake.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m-user', 'chat', datetime('now'), 'pending', 'chan-123', 'slack-x', NULL, '{"text":"hi"}')`,
      )
      .run();
    expect(extractRouting(getPendingMessages()).selfWake).toBe(false);
  });

  it('skips system rows (recall_context) when picking the routing anchor', () => {
    // recall_context is inserted before its paired inbound message and would
    // otherwise hijack inReplyTo, making outbound replies attach to recall-X
    // instead of the real user message X.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('recall-m1', 'system', datetime('now', '-1 second'), 'pending', NULL, NULL, NULL,
               '{"subtype":"recall_context","facts":[]}')`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.inReplyTo).toBe('m1');
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
  });

  it('treats platform_id-set + thread_id-null as authoritative (no session_routing fallback)', () => {
    // Daily background tasks (wiki-synthesise) are scheduled with
    // destination={platformId, channelType, threadId:null} so the report
    // posts to the channel root. A wake triggered by a thread chat earlier
    // populates session_routing with that thread, but the task's explicit
    // null thread_id MUST NOT be overridden by the session's thread.
    // (Real-world manifestation: example-retail synth on 2026-05-01 scheduled
    // for discord channel root, landed in a stale session thread because
    // the prior `??` fallback treated null as "missing".)
    const db = getInboundDb();
    // session_routing isn't part of initTestSessionDb's schema; create it
    // inline with the same structure src/session-manager.ts writes in
    // production (CREATE TABLE happens on first writeSessionRouting call).
    db.prepare(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY,
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT
       )`,
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'slack', 'slack:C123', 'slack:C123:thread-from-prior-wake')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('synth-1', 'task', datetime('now'), 'pending', 'discord:G:C', 'discord', NULL,
               '{"prompt":"synth","quietStatus":true}')`,
    ).run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('discord:G:C');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBeNull(); // NOT 'slack:C123:thread-from-prior-wake'
  });

  it('keeps task routing and quiet status when due admission prepends recall context', () => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES ('recall-quiet-task', 'system', datetime('now'), 'pending', 0,
               '{"subtype":"recall_context"}')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
       VALUES ('quiet-task', 'task', datetime('now'), 'pending', 1, 'slack:C123', 'slack',
               '{"prompt":"one verdict","quietStatus":true}')`,
    ).run();

    const routing = extractRouting(getPendingMessages());
    expect(routing.taskRun).toBe(true);
    expect(routing.quietStatus).toBe(true);
    expect(routing.platformId).toBe('slack:C123');
  });

  it('falls back to session_routing per-field when message has no platform_id (a-to-a case)', () => {
    // Agent-to-agent inbounds carry channel_type='agent' but no platform_id
    // (the message originates from another agent, not a Slack/Discord
    // channel). The reply still needs to route to the session's home
    // channel/thread, so fall back to session_routing for all three fields.
    const db = getInboundDb();
    db.prepare(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY,
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT
       )`,
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'slack', 'slack:C123', 'slack:C123:home-thread')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('a2a-1', 'chat', datetime('now'), 'pending', NULL, 'agent', NULL,
               '{"sender":"sibling-agent","text":"hi"}')`,
    ).run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('slack:C123');
    expect(routing.channelType).toBe('slack');
    expect(routing.threadId).toBe('slack:C123:home-thread');
  });

  it('keeps the Discord session origin for an internal self-agent notification', () => {
    seedSessionRouting('discord', 'discord:123456789000000002:123456789000000007', '123456789000000007');
    insertInternalAgentNotification('appr-note-discord', 'example-beverage-codex');

    const routing = extractRouting(getPendingMessages());
    expect(routing.platformId).toBe('discord:123456789000000002:123456789000000007');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('123456789000000007');
    expect(routing.inReplyTo).toBe('appr-note-discord');
  });

  it('keeps the Slack session origin for an internal self-agent notification', () => {
    seedSessionRouting('slack', 'slack:CTEST00004', 'slack:CTEST00004:1784808844.188429');
    insertInternalAgentNotification('appr-note-slack', 'example-beverage-codex');

    const routing = extractRouting(getPendingMessages());
    expect(routing.platformId).toBe('slack:CTEST00004');
    expect(routing.channelType).toBe('slack');
    expect(routing.threadId).toBe('slack:CTEST00004:1784808844.188429');
    expect(routing.inReplyTo).toBe('appr-note-slack');
  });

  it('task in batch dominates routing — chat-row thread does not hijack', () => {
    // A scheduled task fires while an older chat row from a thread is still
    // pending in the batch (host hadn't synced processing_ack yet, or the
    // container restarted and clearStaleProcessingAcks wiped its claim, and
    // the prior turn's outbound didn't set in_reply_to so respondedIds didn't
    // catch the chat). Without task-row priority, extractRouting picks the
    // older chat row as `first` and the task's reply lands in that thread
    // instead of the channel root.
    //
    // Real-world manifestation: 2026-05-07, example-app Slack agent — every */15
    // task fired into the originating thread instead of #agents-example root.
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('chat-old', 2, 'chat-sdk', datetime('now', '-1 hour'), 'pending',
               'slack:CTEST00004', 'slack-example-labs',
               'slack:CTEST00004:1778100372.246009',
               '{"text":"original user request that opened the thread"}')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('task-new', 4, 'task', datetime('now'), 'pending',
               'slack:CTEST00004', 'slack-example-labs', NULL,
               '{"prompt":"poll inbox"}')`,
    ).run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.inReplyTo).toBe('task-new');
    expect(routing.threadId).toBeNull();
    expect(routing.platformId).toBe('slack:CTEST00004');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(
    id: string,
    kind: string,
    content: object,
    channelType: string | null,
    platformId: string | null,
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        await writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('dispatchResultText — unwrapped output fallback', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function routing(channelType: string | null, platformId: string | null) {
    return { channelType, platformId, threadId: null, inReplyTo: null, quietStatus: false };
  }

  it.each(['<message to="here">Completed</message>', 'Completed'])(
    'preserves a fresh Observatory session thread for final output: %s',
    async (text) => {
      seedDestination('slack-main', 'slack', 'C-MAIN');
      const db = getInboundDb();
      db.run(
        'CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY, channel_type TEXT, platform_id TEXT, thread_id TEXT)',
      );
      db.run("INSERT OR REPLACE INTO session_routing VALUES (1, 'slack', 'C-MAIN', 'thread-observatory')");
      insertMessage('dashboard-steer', 'chat', { text: 'Act in this thread', _via: 'dashboard' });
      const context = extractRouting(getPendingMessages());
      expect(context.threadId).toBe('thread-observatory');
      await dispatchResultText(text, context);
      expect(getUndeliveredMessages()[0].thread_id).toBe('thread-observatory');
    },
  );

  it.each([null, 'explicit-thread'])(
    'preserves explicit inbound routing over the origin fallback: %s',
    async (threadId) => {
      seedDestination('slack-main', 'slack', 'C-MAIN');
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES ('routed', 'chat', ?, 'pending', 'C-MAIN', 'slack', ?, '{}')`,
        )
        .run(new Date().toISOString(), threadId);
      await dispatchResultText('<message to="here">Completed</message>', {
        ...routing('slack', 'C-MAIN'),
        threadId: 'origin-thread',
      });
      expect(getUndeliveredMessages()[0].thread_id).toBe(threadId);
    },
  );

  it('does not carry the origin thread into an unrouted other destination', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('slack-other', 'slack', 'C-OTHER');
    await dispatchResultText('<message to="slack-other">Other room</message>', {
      ...routing('slack', 'C-MAIN'),
      threadId: 'origin-thread',
    });
    expect(getUndeliveredMessages()[0].thread_id).toBeNull();
  });

  it('routes wrapped <message to=...> blocks to their named destinations', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    await dispatchResultText('<message to="discord-side">explicit reply</message>', routing('slack', 'C-MAIN'));

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].platform_id).toBe('chan-9');
    expect(JSON.parse(out[0].content).text).toBe('explicit reply');
  });

  it('multi-destination + unwrapped text → routes to origin destination (the fix)', async () => {
    // Two destinations wired (e.g. agent-shared mode, or auto-wired channels).
    // The agent forgot to wrap and produced bare text. Origin = slack-main
    // because routing.channelType+platformId match it.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    await dispatchResultText('Sorry, I dropped the wrapping. Here is my actual answer.', routing('slack', 'C-MAIN'));

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('C-MAIN');
    expect(JSON.parse(out[0].content).text).toContain('Here is my actual answer.');
  });

  it('multi-destination + unwrapped text + unresolvable origin → drops (no broadcast)', async () => {
    // Routing has no platformId match in destinations table, and we have
    // multiple destinations — there's no safe target, drop the text.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    await dispatchResultText('unwrapped reply with no resolvable origin', routing('telegram', 'unknown-chat'));

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('single-destination + unwrapped text + null routing → routes to the only destination', async () => {
    // Legacy behavior preserved: cron-fired tasks with stripped routing in
    // a single-destination group still get rescued.
    seedDestination('slack-only', 'slack', 'C-ONLY');

    await dispatchResultText('bare text from a null-routed source', routing(null, null));

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('C-ONLY');
  });

  it('wrapped output + scratchpad does NOT trigger fallback', async () => {
    // If the agent wrapped at least one block, scratchpad is just notes
    // — don't double-deliver via fallback.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    await dispatchResultText(
      'thinking out loud<message to="slack-main">final answer</message>more notes',
      routing('slack', 'C-MAIN'),
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('final answer');
  });

  it('only <internal> tags → empty scratchpad → no delivery', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');

    await dispatchResultText('<internal>just thinking</internal>', routing('slack', 'C-MAIN'));

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('stages provider-generated files into outbox and routes them to the origin destination', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES ('in-1', 'chat', datetime('now'), 'completed', 1, 'C-MAIN', 'slack', 'thread-1', '{}')`,
      )
      .run();

    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-image-'));
    const outboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-outbox-'));
    const sourcePath = path.join(sourceDir, 'cafe.png');
    fs.writeFileSync(sourcePath, Buffer.from('png-bytes'));

    const delivered = await dispatchFileAttachment(
      { path: sourcePath, text: 'Preview', filename: '../cafe.png' },
      { ...routing('slack', 'C-MAIN'), inReplyTo: 'trigger-1' },
      outboxRoot,
    );

    expect(delivered).toBe(true);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('C-MAIN');
    // thread_id resolves from the destination's latest inbound row, but
    // in_reply_to must be the TURN's triggering message — never the latest
    // inbound row, which can be a sibling task's unfired future row (the
    // 2026-05 scheduled-task poison).
    expect(out[0].thread_id).toBe('thread-1');
    expect(out[0].in_reply_to).toBe('trigger-1');
    const content = JSON.parse(out[0].content);
    expect(content).toEqual({ text: 'Preview', files: ['cafe.png'] });
    expect(fs.readFileSync(path.join(outboxRoot, out[0].id, 'cafe.png'), 'utf-8')).toBe('png-bytes');
  });

  it('does not broadcast provider-generated files when the origin cannot be resolved', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-image-'));
    const sourcePath = path.join(sourceDir, 'cafe.png');
    fs.writeFileSync(sourcePath, Buffer.from('png-bytes'));

    const delivered = await dispatchFileAttachment(
      { path: sourcePath },
      routing('slack', 'C-UNKNOWN'),
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-outbox-')),
    );

    expect(delivered).toBe(false);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('dispatchResultText — "here" alias', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function routing(channelType: string | null, platformId: string | null) {
    return { channelType, platformId, threadId: null, inReplyTo: null, quietStatus: false };
  }

  it('routes <message to="here"> to the origin destination', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    const result = await dispatchResultText('<message to="here">reply in place</message>', routing('slack', 'C-MAIN'));

    expect(result.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('C-MAIN');
    expect(JSON.parse(out[0].content).text).toBe('reply in place');
  });

  it('is case-insensitive — <message to="HERE"> resolves the same way', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');

    await dispatchResultText('<message to="HERE">shout back</message>', routing('slack', 'C-MAIN'));

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('shout back');
  });

  it('a real destination literally named "here" wins over the alias', async () => {
    seedDestination('here', 'slack', 'C-LITERAL');
    seedDestination('slack-main', 'slack', 'C-MAIN');

    await dispatchResultText('<message to="here">literal destination</message>', routing('slack', 'C-MAIN'));

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('C-LITERAL');
  });

  it('unresolvable origin falls through to unknown-destination handling instead of a silent drop', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    const result = await dispatchResultText(
      '<message to="here">nowhere to land</message>',
      routing('telegram', 'unknown-chat'),
    );

    // No destination and no single-destination fallback available — same
    // "no safe target" outcome as an unknown named destination; not a throw.
    expect(result.sent).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('is rejected like any other block in a task-run session', async () => {
    seedDestination('slack-main', 'slack', 'C-TASK');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES ('task-here', 'task', datetime('now'), 'pending', 1, 'C-TASK', 'slack', 'thread-99', '{"prompt":"do the thing"}')`,
      )
      .run();

    const taskRouting = extractRouting(getPendingMessages());
    const result = await dispatchResultText('<message to="here">task reply</message>', taskRouting);

    expect(result).toEqual({
      sent: 0,
      hasUnwrapped: false,
      taskBlocks: [{ to: 'here', body: 'task reply' }],
    });
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('task-fire routing — a stamped `ncl tasks` row routes end-to-end', () => {
  // Simulates what the host now writes for a routed task series (WI1): a
  // messages_in row with kind='task' carrying its own platform_id/channel_type/
  // thread_id, plus a matching `destinations` row for that channel (as if
  // writeDestinations projected the agent group's wired channel on wake).
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertTaskRow(
    id: string,
    platformId: string | null,
    channelType: string | null,
    threadId: string | null,
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES (?, 'task', datetime('now'), 'pending', 1, ?, ?, ?, '{"prompt":"do the thing"}')`,
      )
      .run(id, platformId, channelType, threadId);
  }

  it('keeps a task-only batch route available without auto-delivering unwrapped final text', async () => {
    seedDestination('slack-main', 'slack', 'C-TASK');
    insertTaskRow('task-1', 'C-TASK', 'slack', 'thread-99');

    const routing = extractRouting(getPendingMessages());
    expect(routing.taskRun).toBe(true);
    expect(routing.platformId).toBe('C-TASK');
    expect(routing.threadId).toBe('thread-99');

    const result = await dispatchResultText('forgot to wrap — here is the run summary', routing);

    expect(result).toEqual({ sent: 0, hasUnwrapped: false, taskBlocks: [] });
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('captures a legacy <message to=...> block for correction without auto-delivering it', async () => {
    seedDestination('slack-main', 'slack', 'C-TASK');
    insertTaskRow('task-2', 'C-TASK', 'slack', 'thread-99');

    const routing = extractRouting(getPendingMessages());
    const result = await dispatchResultText('<message to="slack-main">explicit task reply</message>', routing);

    expect(result).toEqual({
      sent: 0,
      hasUnwrapped: false,
      taskBlocks: [{ to: 'slack-main', body: 'explicit task reply' }],
    });
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('an isolated (unrouted) task row has no destination match and the unwrapped reply is dropped', async () => {
    // No destination seeded, and the task row itself carries null routing
    // (the --isolated case) — origin-fallback and single-destination
    // fallback both miss, so the reply is discarded, not broadcast.
    insertTaskRow('task-3', null, null, null);

    const routing = extractRouting(getPendingMessages());
    expect(routing.platformId).toBeNull();

    await dispatchResultText('nobody to tell', routing);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('dispatchResultText — unclosed-wrapper tolerance', () => {
  // Production repro (helper-codex, 2026-05-17 Slack thread CTEST00004):
  // the agent emitted two `<message to="slack_example-labs_agents-example">`
  // openers in one final response with NO closing `</message>` tag for
  // either. The old regex required a close → zero matches → the entire
  // text fell through to the unwrapped-fallback path and Slack saw the
  // raw `<message to="…">` XML in chat. The tolerant parser slices each
  // body to "next opener / explicit close / EOT" and routes each block,
  // so a single forgotten close no longer leaks markup.
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }
  function routing(channelType: string | null, platformId: string | null) {
    return { channelType, platformId, threadId: null, inReplyTo: null, quietStatus: false };
  }

  it('single unclosed opener at end-of-text → body extends to EOT and routes normally', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    await dispatchResultText('<message to="slack-main">no closing tag, please ship this', routing('slack', 'C-MAIN'));
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(JSON.parse(out[0].content).text).toBe('no closing tag, please ship this');
  });

  it('two consecutive unclosed openers (same dest) → two sends, no markup leak', async () => {
    // Mirrors the helper-codex production repro: two `<message to="…">`
    // openers, no closes. Each becomes its own outbound row.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    await dispatchResultText(
      '<message to="slack-main">first body\nspans multiple lines\n' + '<message to="slack-main">second body acked',
      routing('slack', 'C-MAIN'),
    );
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const texts = out.map((r) => JSON.parse(r.content).text);
    expect(texts).toEqual(['first body\nspans multiple lines', 'second body acked']);
    // No <message…> markup should reach the wire.
    for (const t of texts) {
      expect(t).not.toContain('<message');
      expect(t).not.toContain('</message>');
    }
  });

  it('explicit close before next opener wins as the body endpoint', async () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    await dispatchResultText(
      '<message to="slack-main">first done</message>\nbetween\n' + '<message to="slack-main">second still open',
      routing('slack', 'C-MAIN'),
    );
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0].content).text).toBe('first done');
    expect(JSON.parse(out[1].content).text).toBe('second still open');
    // The "between" text is scratchpad — never delivered (a partial wrap
    // counts as wrapped output, so the fallback doesn't fire).
  });

  it('opener with empty to="" → block dropped, no markup leaks via fallback', async () => {
    // Malformed opener — drop the block and ensure any residual `<message…>`
    // text in the fallback path gets stripped before reaching the user.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    await dispatchResultText('<message to="">malformed body</message>\nrest of reply', routing('slack', 'C-MAIN'));
    const out = getUndeliveredMessages();
    // Since the malformed opener's body becomes scratchpad and there are
    // no successful sends, the fallback fires on the combined scratchpad.
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('malformed body');
    expect(text).toContain('rest of reply');
    expect(text).not.toContain('<message');
    expect(text).not.toContain('</message>');
  });

  it('stray `<message…>` markup in scratchpad-only text gets stripped from fallback', async () => {
    // Defensive: an agent that emits orphan opener tokens with no
    // matching close but ALSO no valid destination resolution should
    // never expose raw markup to the user. The opener regex requires
    // a `to="…"` attribute, so a bare `<message>` literal (no `to`)
    // doesn't even match — but if one slips in via a different path
    // (e.g. an unknown destination plus a stripped wrapper), the strip
    // catches it.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    await dispatchResultText(
      'pre-text\n<message to="unknown-destination">body</message>\npost-text',
      routing('slack', 'C-MAIN'),
    );
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).not.toContain('<message');
    expect(text).not.toContain('</message>');
  });
});

describe('processQuery done-flag invariant (codex F4 regression guard)', () => {
  it('result handler does NOT flip done — provider stream stays open across turns', async () => {
    // Codex F4 (2026-05-05): a prior commit set `done = true` synchronously
    // inside the `event.type === 'result'` branch. The polling interval
    // gates on `done`, so flipping it after the first result starved every
    // follow-up trigger=1 row in the session — the host wouldn't wake a
    // second container (this one was still running) and there was no
    // processing claim, so recovery fell back to the 30-min absolute
    // heartbeat ceiling. The provider's events generator stays open until
    // explicit `query.end()`/abort (see container/agent-runner/src/providers/
    // claude.ts:1080); only the outer for-await returning should flip
    // `done`. This guard catches re-introduction of the synchronous flip.
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('./poll-loop.ts', import.meta.url), 'utf8');
    const lines = src.split('\n');
    // Anchor on `markCompleted(initialBatchIds);` — the only call site is
    // inside the result handler (other completion paths use `markCompleted(skipped)`
    // or `markCompleted(keptIds)`). The 20 lines BEFORE this anchor are
    // the result-handler body up to the `} else if (event.type === 'result') {`
    // line. Anywhere in that window flipping `done` is the regression.
    const anchorIdx = lines.findIndex((l) => l.includes('markCompleted(initialBatchIds)'));
    expect(anchorIdx).toBeGreaterThan(-1);
    const handlerWindow = lines.slice(Math.max(0, anchorIdx - 20), anchorIdx + 1).join('\n');
    // Strip line comments before the regression check so the explanatory
    // comment naming the prohibited code doesn't itself trip the assertion.
    const codeOnly = handlerWindow
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');
    expect(codeOnly).not.toContain('done = true');
  });

  it('does NOT throw on a retryable (api_retry) event; surfaces only if no result arrives', async () => {
    // 2026-06-26: processQuery threw on EVERY error event, including the SDK's
    // own `api_retry` retry signal (retryable:true). That dead-turned long
    // ultracode turns with a bogus "Error: API retry" the SDK would have
    // recovered from. The handler must `continue` on a retryable event (let the
    // SDK's internal retry finish) and only surface it post-loop when the stream
    // ended without a result. Source-anchored like the F4 guard above — driving
    // processQuery needs full stream+session-DB fixtures this file avoids.
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('./poll-loop.ts', import.meta.url), 'utf8');
    const errIdx = src.indexOf("if (event.type === 'error') {");
    expect(errIdx).toBeGreaterThan(-1);
    const handler = src.slice(errIdx, errIdx + 700);
    // retryable branch continues instead of throwing
    expect(handler).toContain('if (event.retryable)');
    expect(handler).toContain('lastRetryableErr = err;');
    expect(handler).toContain('continue;');
    // and the post-loop surface exists so a never-recovering stream isn't silent
    expect(src).toContain('if (!sawResult && lastRetryableErr) throw lastRetryableErr;');
  });
});

describe('isAupRefusal', () => {
  it('test_isAupRefusal_matches_canonical_anthropic_envelope', () => {
    const refusal =
      'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy ' +
      '(https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different approach. ' +
      'If you are seeing this refusal repeatedly, try running /model claude-sonnet-4-20250514 to switch models.';
    expect(isAupRefusal(refusal)).toBe(true);
  });

  it('test_isAupRefusal_does_not_match_legitimate_prose_about_policy', () => {
    // Discussion of the policy URL alone shouldn't trip the detector — both
    // anchors are required.
    expect(isAupRefusal('See https://www.anthropic.com/legal/aup for details on the usage policy.')).toBe(false);
    expect(isAupRefusal('Claude Code is unable to respond when offline.')).toBe(false);
  });

  it('test_isAupRefusal_returns_false_for_empty_and_short_text', () => {
    expect(isAupRefusal('')).toBe(false);
    expect(isAupRefusal('Done.')).toBe(false);
    expect(isAupRefusal('API Error: rate limit exceeded.')).toBe(false);
  });
});

describe('handleEvent — terminal-error visibility (Layer-1 fix)', () => {
  // Background: when a provider yields `{type:'error', retryable:false}`
  // (e.g. codex hard turn-timeout, claude quota exhaustion), the user
  // used to see nothing — the for-await would exit, the next turn would
  // also time out the same way, and 30 min later host-sweep silently
  // reaped the container. The fix surfaces the error on the user's
  // delivery channel as a normal chat outbound. Retryable errors stay
  // quiet (the runner retries upstream); only the terminal branch posts.

  // A quota-classified error consults the config to decide whether a
  // fallback provider exists. In the container that is always loaded before
  // the loop runs; here it has to be loaded explicitly. loadConfig falls back
  // to defaults when the file is absent, which is the "no fallback declared"
  // case these tests assume.
  beforeEach(() => {
    _resetConfig();
    loadConfig();
  });

  function routingFixture() {
    return {
      channelType: 'slack',
      platformId: 'C-TEST',
      threadId: 'T-TEST',
      inReplyTo: null,
      quietStatus: false,
    };
  }

  it('retryable=false writes a visible chat outbound on the session route', async () => {
    await handleEvent({ type: 'error', message: 'Turn timed out after 300000ms', retryable: false }, routingFixture());
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('C-TEST');
    expect(out[0].thread_id).toBe('T-TEST');
    const body = JSON.parse(out[0].content) as { text: string };
    expect(body.text).toContain('Turn timed out after 300000ms');
    expect(body.text).toContain('pick up from your next message');
  });

  it('retryable=true is silent — runner is still working on a fix internally', async () => {
    await handleEvent({ type: 'error', message: 'API retry', retryable: true }, routingFixture());
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('classification is included in the chat surface for terminal errors', async () => {
    await handleEvent(
      { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' },
      routingFixture(),
    );
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const body = JSON.parse(out[0].content) as { text: string };
    expect(body.text).toContain('Rate limit');
  });

  it('a quota error carrying a measured resetAt still surfaces when no fallback is declared', async () => {
    // The Codex pre-turn park (providers/codex.ts parkedTurnEvents) arrives
    // here with `resetAt`; with nothing to route to, the outage stays loud.
    await handleEvent(
      {
        type: 'error',
        message: 'Codex rate limit [seven_day] 92% used',
        retryable: false,
        classification: 'quota',
        resetAt: '2026-09-17T00:00:00.000Z',
      },
      routingFixture(),
    );
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    expect(JSON.parse(out[0].content)).toMatchObject({ text: expect.stringContaining('92% used') });
  });
});

describe('buildProviderUnavailableReport — the provider_unavailable row the host handler reads', () => {
  it('carries a measured resetAt and a reason only when known, and never widens the base row otherwise', () => {
    expect(buildProviderUnavailableReport('codex', true, 'usage limit reached', 'claude')).toEqual({
      action: 'provider_unavailable',
      provider: 'codex',
      classification: 'quota',
      message: 'usage limit reached',
      fallbackProvider: 'claude',
    });
    expect(
      buildProviderUnavailableReport('codex', true, 'Codex rate limit [seven_day] 92% used', 'claude', {
        resetAt: '2026-09-17T00:00:00.000Z',
        reason: null,
      }),
    ).toEqual({
      action: 'provider_unavailable',
      provider: 'codex',
      classification: 'quota',
      message: 'Codex rate limit [seven_day] 92% used',
      fallbackProvider: 'claude',
      resetAt: '2026-09-17T00:00:00.000Z',
    });
    expect(
      buildProviderUnavailableReport('codex', false, 'codex_system_error: thread entered systemError state', 'claude', {
        resetAt: null,
        reason: 'system_error',
      }),
    ).toEqual({
      action: 'provider_unavailable',
      provider: 'codex',
      classification: 'unavailable',
      message: 'codex_system_error: thread entered systemError state',
      fallbackProvider: 'claude',
      reason: 'system_error',
    });
  });

  it('truncates the message to the 500-char cap the host stores', () => {
    const report = buildProviderUnavailableReport('codex', false, 'x'.repeat(900), 'claude');
    expect((report.message as string).length).toBe(500);
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

/**
 * provider_executing tracks TURNS, not stream lifetime. A multi-turn stream
 * stays open after `result` to accept pushes (claude.ts's generator exits only
 * on end()/abort), so a flag raised for the whole processQuery call would sit
 * at 1 through the container's entire idle stretch and hold the host's
 * scheduled-task reaper off a container with nothing left to do. The host side
 * of the contract is pinned in src/modules/mailbox/mailbox.test.ts.
 */
describe('processQuery provider_executing', () => {
  const providerExecuting = (): number =>
    (
      getOutboundDb().prepare('SELECT provider_executing FROM container_state WHERE id = 1').get() as
        | { provider_executing: number }
        | undefined
    )?.provider_executing ?? 0;

  it('clears at `result` while the stream stays open, and raises again on the next pushed turn', async () => {
    const observed: Record<string, number> = {};
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-exec-flag' };
      observed.duringTurn = providerExecuting();
      // Unwrapped output draws the one-shot re-wrap nudge, which pushes into
      // the open stream — a genuinely new turn, so the flag must go back up.
      yield { type: 'result', text: 'unwrapped' };
      observed.afterNudgedResult = providerExecuting();
      // `unwrappedNudged` is one-shot, so this result nudges nothing: the turn
      // is over and the stream is still open. This is the idle stretch a
      // whole-call bracket would have kept flagged busy right through.
      yield { type: 'result', text: 'unwrapped again' };
      observed.afterFinalResult = providerExecuting();
      // A compaction re-injects bootstrap through pushToQuery — another turn
      // that holds no processing claim of its own.
      yield { type: 'compacted', text: 'Context compacted.' };
      observed.afterCompactionPush = providerExecuting();
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {});

    expect(observed.duringTurn).toBe(1);
    expect(observed.afterNudgedResult).toBe(1);
    expect(observed.afterFinalResult).toBe(0);
    expect(observed.afterCompactionPush).toBe(1);
    // The stream ended without a further `result`; the finally is the floor.
    expect(providerExecuting()).toBe(0);
  });

  // Codex review on #333: lowering the turn level at `result` is correct, but
  // the handling that FOLLOWS completes the batch's processing claim and only
  // then decides whether to push a corrective follow-up. A sweep tick landing
  // in that gap saw no due row, no claim, no continuation and no raised turn,
  // and killed the container mid-decision. The bounded scope spans the gap.
  it('stays raised while result handling completes the claim and decides on a follow-up', async () => {
    const operations = getAgentMailbox().operations;
    const markMessages = operations.markMessages.bind(operations);
    const atCompletion: number[] = [];
    const spy = spyOn(operations, 'markMessages').mockImplementation((ids, status) => {
      if (status === 'completed') atCompletion.push(providerExecuting());
      markMessages(ids, status);
    });

    try {
      // Unwrapped output draws the one-shot re-wrap nudge, so handling pushes
      // a follow-up turn AFTER completing the batch — the exact ordering the
      // race depends on.
      const { query } = makeResultQuery({ type: 'result', text: 'unwrapped' });
      await processQuery(query, ERR_ROUTING, ['m-claimed'], 'claude', undefined, 'prompt', undefined, {});
    } finally {
      spy.mockRestore();
    }

    // The claim was completed at least once, and the flag was raised every
    // time — never the window where every reaper term reads idle.
    expect(atCompletion.length).toBeGreaterThan(0);
    expect(atCompletion.every((value) => value === 1)).toBe(true);
  });

  // Codex review on #333, round 2: OpenCodeProvider.push() has no merge path.
  // Every push is appended to `pending` and dequeued later as its OWN turn, so
  // the `result` that ends the running turn can arrive with a follow-up already
  // accepted and not yet dispatched. Lowering the turn level there published
  // idle across that whole gap — and since the follow-up's rows were completed
  // when they were pushed, no due row, claim or continuation covered it either.
  // The provider now reports its queue and the poll-loop holds the level up.
  it('stays raised across a provider-queued follow-up turn (opencode push semantics)', async () => {
    const pending: string[] = [];
    const observed: Record<string, number> = {};
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-queued' };
      // A compaction re-injects the bootstrap through pushToQuery while this
      // turn is still running. On a queueing provider it lands in `pending`
      // instead of merging into the turn.
      yield { type: 'compacted', text: 'Context compacted.' };
      expect(pending.length).toBe(1);
      // The running turn now ends. Scratchpad-only text so result handling
      // pushes nothing of its own — the queued prompt is the ONLY work left,
      // and it has not started.
      yield { type: 'result', text: '<internal>just thinking</internal>' };
      // The generator resumes only after result handling finished, so this is
      // exactly the window a sweep tick could land in.
      observed.inGap = providerExecuting();
      pending.shift(); // the queued turn starts
      observed.queuedTurnRunning = providerExecuting();
      yield { type: 'result', text: '<internal>done</internal>' };
      observed.afterQueuedTurnEnds = providerExecuting();
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pending.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
      hasQueuedWork: () => pending.length > 0,
    };

    await processQuery(query, ERR_ROUTING, ['m-queued'], 'opencode', undefined, 'prompt', undefined, {});

    expect(observed.inGap).toBe(1);
    expect(observed.queuedTurnRunning).toBe(1);
    // Queue drained and nothing pushed — the container is genuinely idle now.
    expect(observed.afterQueuedTurnEnds).toBe(0);
    expect(providerExecuting()).toBe(0);
  });

  // Fleet incident 2026-09-10: a resumed task's first turn answered empty
  // ("Result: (empty)"), and the SDK — not the runner — started a second
  // turn on its own inside the same still-open stream to do the real work.
  // claude.ts implements no `hasQueuedWork`, so the empty `result` already
  // lowered the flag, and nothing pushed to raise it again: the task reaper
  // killed the container mid-work on the next sweep tick, and it kept
  // happening because each kill orphaned more background work. `init` fires
  // at the start of EVERY turn — including one the SDK starts unprompted —
  // so raising the flag there, not just on push, is what keeps a resumed
  // container alive through the real turn.
  it('raises again on an SDK-started turn after an empty result, with no push involved', async () => {
    const observed: Record<string, number> = {};
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-resume' };
      // The empty first turn of a resume: no text, so dispatch/nudge never
      // runs and nothing is pushed — this is exactly what lowers the flag.
      yield { type: 'result', text: null };
      observed.afterEmptyResult = providerExecuting();
      // The SDK starts the real turn on its own — not a pushToQuery call.
      yield { type: 'init', continuation: 'sess-resume' };
      observed.afterSecondInit = providerExecuting();
      yield { type: 'progress', message: 'working' };
      yield { type: 'result', text: '<internal>done</internal>' };
      observed.afterFinalResult = providerExecuting();
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, ERR_ROUTING, ['m-resume'], 'claude', undefined, 'prompt', undefined, {});

    expect(observed.afterEmptyResult).toBe(0);
    expect(observed.afterSecondInit).toBe(1);
    expect(observed.afterFinalResult).toBe(0);
    expect(providerExecuting()).toBe(0);
  });

  // #617: the CLI can answer a turn it started itself while the task prompt
  // is still queued behind it. The provider says so (hasQueuedWork), and the
  // level stays up across that gap instead of dropping until the next `init`.
  it('holds the level across a turn the CLI starts while the task prompt is still queued', async () => {
    const observed: Record<string, number> = {};
    let queued = true;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-queued' };
      yield { type: 'result', text: null, answeredPrompts: [] };
      observed.afterUnprompted = providerExecuting();
      yield { type: 'init', continuation: 'sess-queued' };
      queued = false; // the task prompt's own turn answers it
      yield { type: 'result', text: '<internal>done</internal>', answeredPrompts: ['p-initial'] };
      observed.afterAnswer = providerExecuting();
    }
    const query: AgentQuery = {
      push: () => {},
      initialPromptId: 'p-initial',
      hasQueuedWork: () => queued,
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, ERR_ROUTING, ['m-queued'], 'claude', undefined, 'prompt', undefined, {});

    expect(observed.afterUnprompted).toBe(1);
    expect(observed.afterAnswer).toBe(0);
  });

  // 2026-09-15: a task session's parent turn launched a background worker,
  // ended on a `wait`, and the idle reaper killed the container 15–60s later
  // — nine times in 80 minutes, every worker lost. The provider reports the
  // CLI's live background set (hasBackgroundWork); `result` must hold the
  // level while it is non-empty. The provider reports the level again at the
  // CLI's idle, which the CLI withholds until background agents are done and
  // any follow-up turn they start has run — that report is what lowers it.
  it('holds the level at `result` while the provider reports live background work, and lowers on the idle report', async () => {
    const observed: Record<string, number> = {};
    let live = 1;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-bg' };
      yield { type: 'result', text: '<internal>delegated, waiting</internal>', answeredPrompts: ['p-initial'] };
      observed.afterResultWithBackground = providerExecuting();
      // The worker finishes with no follow-up turn; the CLI's idle arrives.
      live = 0;
      yield { type: 'background_work', live: 0 };
      observed.afterIdleReport = providerExecuting();
    }
    const query: AgentQuery = {
      push: () => {},
      initialPromptId: 'p-initial',
      hasQueuedWork: () => false,
      hasBackgroundWork: () => live > 0,
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, ERR_ROUTING, ['m-bg'], 'claude', undefined, 'prompt', undefined, {});

    expect(observed.afterResultWithBackground).toBe(1);
    expect(observed.afterIdleReport).toBe(0);
    expect(providerExecuting()).toBe(0);
  });

  it('keeps the level through the follow-up turn a background completion starts, and lowers at its result', async () => {
    const observed: Record<string, number> = {};
    let live = 1;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-bg2' };
      yield { type: 'result', text: '<internal>delegated</internal>', answeredPrompts: ['p-initial'] };
      observed.afterResult = providerExecuting();
      // No idle report while the worker runs: the CLI withholds it. The
      // worker finishes and the CLI folds the completion in as a turn of its
      // own — `init` before any report.
      live = 0;
      yield { type: 'init', continuation: 'sess-bg2' };
      observed.followUpRunning = providerExecuting();
      yield { type: 'result', text: '<internal>reported</internal>', answeredPrompts: [] };
      observed.afterFollowUp = providerExecuting();
      // Then the idle report — nothing left to lower.
      yield { type: 'background_work', live: 0 };
      observed.afterIdleReport = providerExecuting();
    }
    const query: AgentQuery = {
      push: () => {},
      initialPromptId: 'p-initial',
      hasQueuedWork: () => false,
      hasBackgroundWork: () => live > 0,
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, ERR_ROUTING, ['m-bg2'], 'claude', undefined, 'prompt', undefined, {});

    expect(observed.afterResult).toBe(1);
    expect(observed.followUpRunning).toBe(1);
    expect(observed.afterFollowUp).toBe(0);
    expect(observed.afterIdleReport).toBe(0);
  });

  it('ignores a background report that still shows live work, or that lands mid-turn', async () => {
    const observed: Record<string, number> = {};
    let live = 1;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-bg3' };
      // A report mid-turn (whatever it says) never lowers a running turn.
      yield { type: 'background_work', live: 0 };
      observed.midTurn = providerExecuting();
      yield { type: 'result', text: '<internal>delegated</internal>', answeredPrompts: ['p-initial'] };
      observed.afterResult = providerExecuting();
      // A between-turns report with work still live keeps the hold.
      yield { type: 'background_work', live: 1 };
      observed.afterLiveReport = providerExecuting();
      live = 0;
      yield { type: 'background_work', live: 0 };
      observed.afterIdleReport = providerExecuting();
    }
    const query: AgentQuery = {
      push: () => {},
      initialPromptId: 'p-initial',
      hasQueuedWork: () => false,
      hasBackgroundWork: () => live > 0,
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, ERR_ROUTING, ['m-bg3'], 'claude', undefined, 'prompt', undefined, {});

    expect(observed.midTurn).toBe(1);
    expect(observed.afterResult).toBe(1);
    expect(observed.afterLiveReport).toBe(1);
    expect(observed.afterIdleReport).toBe(0);
  });

  it('lowers the level when the provider settles the queued prompt at idle', async () => {
    const observed: Record<string, number> = {};
    let queued = true;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-settle' };
      yield { type: 'result', text: null, answeredPrompts: [] };
      observed.afterUnprompted = providerExecuting();
      queued = false; // idle: the prompt was consumed with no echo
      yield { type: 'settled', unansweredPrompts: ['p-initial'] };
      observed.afterSettled = providerExecuting();
    }
    const query: AgentQuery = {
      push: () => {},
      initialPromptId: 'p-initial',
      hasQueuedWork: () => queued,
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, ERR_ROUTING, ['m-settle'], 'claude', undefined, 'prompt', undefined, {});

    expect(observed.afterUnprompted).toBe(1);
    expect(observed.afterSettled).toBe(0);
  });

  // Baseline / negative control for the two SDK-started-turn cases above —
  // passes with or without the `init` fix (there is no second turn to miss),
  // so it proves the fix didn't just start pinning the flag unconditionally.
  it('baseline: stays clear when a turn ends and the stream produces nothing further', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-quiet' };
      yield { type: 'result', text: '<internal>done</internal>' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, ERR_ROUTING, ['m-quiet'], 'claude', undefined, 'prompt', undefined, {});

    expect(providerExecuting()).toBe(0);
  });

  // The sibling case to the empty-result one above: the SDK can also start
  // an unprompted further turn after an ORDINARY non-empty result (e.g. a
  // background task's notification lands as a normal turn, then the SDK
  // keeps working on its own). Covered separately because a non-empty result
  // walks a different code path (dispatchResultText / completeDeliveredPrompt)
  // before the next `init` arrives, and that path must not be what's making
  // the fix above look like it works.
  it('raises again on an SDK-started turn after a non-empty result (background-notification path)', async () => {
    const observed: Record<string, number> = {};
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-notify' };
      yield { type: 'result', text: '<internal>background task finished</internal>' };
      observed.afterFirstResult = providerExecuting();
      // The SDK starts a further turn on its own — not a pushToQuery call.
      yield { type: 'init', continuation: 'sess-notify' };
      observed.afterSecondInit = providerExecuting();
      yield { type: 'result', text: '<internal>done</internal>' };
      observed.afterFinalResult = providerExecuting();
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, ERR_ROUTING, ['m-notify'], 'claude', undefined, 'prompt', undefined, {});

    expect(observed.afterFirstResult).toBe(0);
    expect(observed.afterSecondInit).toBe(1);
    expect(observed.afterFinalResult).toBe(0);
    expect(providerExecuting()).toBe(0);
  });
});

it('re-bootstraps bounded canon and capabilities immediately after provider compaction', async () => {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-before-compaction' };
    yield { type: 'compacted', text: 'Context compacted.' };
    yield { type: 'result', text: '<message to="discord-test">continued</message>' };
  }
  const query: AgentQuery = {
    push: (message) => pushes.push(message),
    end: () => {},
    events: events(),
    abort: () => {},
  };

  await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', 'sess-before-compaction', {});

  expect(pushes.some((message) => message.includes('<trusted_capabilities_json>'))).toBe(true);
  expect(pushes.some((message) => message.includes('runner-fresh-context-bootstrap'))).toBe(true);
});

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  quietStatus: false,
};

describe('provider-event ordering across the awaited outbound write', () => {
  // R1 made writeMessageOut Promise-returning (upstream's mailbox contract) and
  // handleEvent async with it. The poll loop's `for await (const event of
  // query.events)` awaits handleEvent (poll-loop.ts:1762), so the change is
  // shape-only: event N's outbound row is committed before event N+1 is
  // handled. Each write is held open by a gate this test releases by hand, so
  // "the next event has not been handled yet" is a fact about that await and
  // not a race against a timer. Drop the await and this fails on the first
  // assertion — all three writes start before any is released.
  test('outbound writes from consecutive provider events keep monotonic seq and arrive before the next event is handled', async () => {
    const operations = getAgentMailbox().operations;
    const write = operations.writeMessageOut.bind(operations);
    const order = ['first', 'second', 'third'];
    const trace: string[] = [];
    const gates: Array<() => void> = [];

    const spy = spyOn(operations, 'writeMessageOut').mockImplementation(async (message) => {
      const label = (JSON.parse(message.content) as { text: string }).text;
      trace.push(`start:${label}`);
      await new Promise<void>((resolve) => gates.push(resolve));
      const sequence = await write(message);
      trace.push(`end:${label}`);
      return sequence;
    });

    async function* events(): AsyncGenerator<ProviderEvent> {
      for (const message of order) yield { type: 'progress', message };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };

    // Not awaited yet: the stream parks inside the first write until released.
    const finished = processQuery(query, ERR_ROUTING, [], 'claude', undefined, 'prompt', undefined, {});
    // Generous enough that a loop which did NOT await would have run the whole
    // stream and pushed all three starts by the time the first assertion runs.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

    try {
      for (let index = 0; index < order.length; index++) {
        await settle();
        expect(trace).toEqual([
          ...order.slice(0, index).flatMap((label) => [`start:${label}`, `end:${label}`]),
          `start:${order[index]}`,
        ]);
        gates[index]!();
      }
      await finished;
    } finally {
      spy.mockRestore();
    }

    await settle();
    expect(trace).toEqual(order.flatMap((label) => [`start:${label}`, `end:${label}`]));

    const rows = getOutboundDb()
      .prepare("SELECT seq, content FROM messages_out WHERE kind = 'status' ORDER BY seq ASC")
      .all() as Array<{ seq: number; content: string }>;
    expect(rows.map((row) => (JSON.parse(row.content) as { text: string }).text)).toEqual(order);
    const sequences = rows.map((row) => row.seq);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(order.length);
  });
});

describe('turn_id — correlates split rows of one turn, distinguishes separate turns', () => {
  it('a multi-model result event writes N turn_usage rows sharing one turn_id; a later result event gets a different one', async () => {
    // The whole value of this field: usage_daily counts turns by ROW, so a
    // turn split across models (Opus parent + Sonnet subagent) over-counts
    // by one per extra model. turn_id lets COUNT(DISTINCT turn_id) recover
    // the true turn count instead.
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'turn-id-test' };
      yield {
        type: 'result',
        text: 'first turn, two models',
        usage: [
          { model: 'claude-opus-5', inputTokens: 100 },
          { model: 'claude-sonnet-5', inputTokens: 50 },
        ],
      };
      yield {
        type: 'result',
        text: 'second turn, one model',
        usage: { model: 'claude-opus-5', inputTokens: 10 },
      };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };

    await processQuery(query, ERR_ROUTING, [], 'claude', undefined, 'prompt', undefined, {});

    const rows = getTurnUsageRows();
    expect(rows).toHaveLength(3);

    // First result's two model-rows share one turn_id.
    expect(rows[0].turn_id).not.toBeNull();
    expect(rows[1].turn_id).toBe(rows[0].turn_id);

    // Second, separate result event gets its own, different turn_id.
    expect(rows[2].turn_id).not.toBeNull();
    expect(rows[2].turn_id).not.toBe(rows[0].turn_id);
  });
});

describe('mid-turn fast-mode changes', () => {
  it('ends the active query and leaves the flag row pending for a fast-tier respawn', async () => {
    insertMessage('m-fast', 'chat', {
      sender: 'Operator',
      text: 'use fast mode',
      flagIntent: { turnFast: true },
    });

    let release!: () => void;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    let endCalls = 0;
    let pushCalls = 0;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'codex-thread' };
      await ended;
    }
    const query: AgentQuery = {
      push: () => {
        pushCalls += 1;
      },
      end: () => {
        endCalls += 1;
        release();
      },
      abort: release,
      events: events(),
    };

    await processQuery(query, ERR_ROUTING, [], 'codex', undefined, 'initial', undefined, { fast: false });

    expect(endCalls).toBe(1);
    expect(pushCalls).toBe(0);
    expect(getPendingMessages().map((m) => m.id)).toContain('m-fast');
    // The full Bun suite runs CPU-heavy design-review tests concurrently in the
    // same process. Keep this above their longest event-loop stall; in isolation
    // the 500 ms active-poll path completes in well under a second.
  }, 30_000);
});

describe('interim text — a <message> block written before a tool call', () => {
  function seedOrigin(): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('discord-main', 'discord-main', 'channel', 'discord', 'chan-1', NULL)`,
      )
      .run();
  }
  const run = (events: ProviderEvent[]) => {
    const pushes: string[] = [];
    async function* gen(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      for (const e of events) yield e;
    }
    const query: AgentQuery = {
      push: (m: string) => void pushes.push(m),
      end: () => {},
      abort: () => {},
      events: gen(),
    };
    return processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {}).then(() => pushes);
  };
  const sentTexts = () => getUndeliveredMessages().map((m) => JSON.parse(m.content).text as string);

  it('delivers the wrapped block and drops the narration around it', async () => {
    seedOrigin();
    await run([
      { type: 'interim_text', text: 'Pushed. <message to="here">head is 2c8cf18</message> Now the benchmark.' },
      { type: 'result', text: '<message to="here">benchmark done</message>' },
    ]);

    expect(sentTexts()).toEqual(['head is 2c8cf18', 'benchmark done']);
  });

  it('never delivers bare interim narration, and does not nudge for it', async () => {
    seedOrigin();
    const pushes = await run([
      { type: 'interim_text', text: 'Now run the seam suites, then typecheck.' },
      { type: 'result', text: '<message to="here">green</message>' },
    ]);

    expect(sentTexts()).toEqual(['green']);
    expect(pushes).toHaveLength(0);
  });

  it('does not send a block twice when the final text repeats it', async () => {
    seedOrigin();
    const block = '<message to="here">head is 2c8cf18</message>';
    await run([
      { type: 'interim_text', text: block },
      { type: 'result', text: `${block}\n<message to="here">and CI is green</message>` },
    ]);

    expect(sentTexts()).toEqual(['head is 2c8cf18', 'and CI is green']);
  });

  it('forgets interim deliveries at an empty result, so the next turn can say the same thing', async () => {
    seedOrigin();
    const block = '<message to="here">still running</message>';
    await run([
      { type: 'interim_text', text: block },
      { type: 'result', text: null },
      { type: 'result', text: block },
    ]);

    expect(sentTexts()).toEqual(['still running', 'still running']);
  });

  it('leaves an unclosed block for the final text', async () => {
    seedOrigin();
    await run([
      { type: 'interim_text', text: '<message to="here">half a thought' },
      { type: 'result', text: null },
    ]);

    expect(sentTexts()).toEqual([]);
  });

  it('delivers nothing mid-turn in a task run', async () => {
    seedOrigin();
    const pushes: string[] = [];
    async function* gen(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      yield { type: 'interim_text', text: '<message to="here">from a task</message>' };
      yield { type: 'result', text: null };
    }
    const query: AgentQuery = {
      push: (m: string) => void pushes.push(m),
      end: () => {},
      abort: () => {},
      events: gen(),
    };
    await processQuery(query, { ...ERR_ROUTING, taskRun: true }, [], 'claude', undefined, 'prompt', undefined, {});

    expect(sentTexts()).toEqual([]);
  });
});

describe('error result with no <message> envelope', () => {
  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {});

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(budgetText);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });

  it('still nudges (and does not deliver) a normal unwrapped result', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {});

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

describe('transientOverloadDelayMs — server-overload backoff schedule', () => {
  // base 1500ms, cap 30_000ms, full jitter (delay ∈ [ceil/2, ceil]).
  it('grows exponentially then clamps at the 30s cap', () => {
    // rand=1 → top of the jitter band = the full ceiling for that attempt.
    expect(transientOverloadDelayMs(0, 1)).toBe(1500); // 1500 * 2^0
    expect(transientOverloadDelayMs(1, 1)).toBe(3000); // 1500 * 2^1
    expect(transientOverloadDelayMs(4, 1)).toBe(24000); // 1500 * 2^4
    expect(transientOverloadDelayMs(5, 1)).toBe(30000); // 48000 → clamped
    expect(transientOverloadDelayMs(29, 1)).toBe(30000); // last attempt, still clamped
  });

  it('applies full jitter — never below half the ceiling, never above it', () => {
    // rand=0 → bottom of the band = ceil/2.
    expect(transientOverloadDelayMs(0, 0)).toBe(750);
    expect(transientOverloadDelayMs(5, 0)).toBe(15000); // clamped ceil 30000 / 2
    // 30 attempts capped at 30s each ≈ 13 min worst case — under the host
    // sweep's 30-min idle ceiling (heartbeat is touched across each sleep).
    let worstCaseMs = 0;
    for (let n = 0; n < 30; n++) worstCaseMs += transientOverloadDelayMs(n, 1);
    expect(worstCaseMs).toBeLessThan(30 * 60 * 1000);
  });
});

describe('durable continuation wiring', () => {
  beforeEach(() => {
    // Register chan-1 as a destination so <message to="chan-1"> resolves and
    // results are "delivered" rather than routed through the re-wrap nudge.
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('chan-1', 'Chan 1', 'channel', 'discord', 'chan-1', NULL)`,
      )
      .run();
  });

  it('pushes a queued continuation only after a delivered final result', async () => {
    const queued = queueWorkContinuation('write the dbt tests');
    expect(queued.accepted).toBe(true);
    const { query, pushes } = makeResultQuery({ type: 'result', text: '<message to="chan-1">On it.</message>' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {}, 'runner-a');

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('write the dbt tests');
    expect(pushes[0]).toContain('Continue with it NOW');
    expect(getWorkContinuation()).toMatchObject({ task: 'write the dbt tests', phase: 'queued' });
  });

  it('future-tense prose and NEXT text have no control effect', async () => {
    const { query, pushes } = makeResultQuery({
      type: 'result',
      text: '<message to="chan-1">Working on that next.</message>\n<internal>NEXT: old parser text</internal>',
    });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {});

    expect(pushes).toHaveLength(0);
    expect(getWorkContinuation()).toBeUndefined();
  });

  it('a replacement made during running work survives the stale result', async () => {
    const first = queueWorkContinuation('first task');
    if (!first.accepted) throw new Error('expected continuation');
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      yield { type: 'result', text: '<message to="chan-1">initial turn done</message>' };
      queueWorkContinuation('replacement task');
      yield { type: 'result', text: '<message to="chan-1">old task result</message>' };
    }
    const query: AgentQuery = { push: (p) => pushes.push(p), end: () => {}, abort: () => {}, events: events() };

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {}, 'runner-a');

    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toContain('first task');
    expect(pushes[1]).toContain('replacement task');
    expect(getWorkContinuation()).toMatchObject({ task: 'replacement task', phase: 'queued' });
  });

  it('does not launch while a wrapping nudge is in flight', async () => {
    queueWorkContinuation('must stay queued');
    getInboundDb().prepare('DELETE FROM destinations').run();
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare prose' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {}, 'runner-a');

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
    expect(getWorkContinuation()).toMatchObject({ task: 'must stay queued', phase: 'queued' });
  });

  it('requeues a continuation when its stream ends without completing it', async () => {
    const queued = queueWorkContinuation('resume after stream loss');
    if (!queued.accepted) throw new Error('expected continuation');
    markWorkContinuationRunning(queued.continuation.id, 'runner-a');
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };

    await processQuery(
      query,
      ERR_ROUTING,
      [],
      'claude',
      undefined,
      buildWorkContinuationPrompt(queued.continuation.task),
      undefined,
      {},
      'runner-a',
      queued.continuation.id,
    );

    expect(getWorkContinuation()).toMatchObject({ id: queued.continuation.id, phase: 'queued' });
  });

  it('requeues and suppresses a deterministic error result until real inbound', async () => {
    const queued = queueWorkContinuation('resume after provider recovery');
    if (!queued.accepted) throw new Error('expected continuation');
    markWorkContinuationRunning(queued.continuation.id, 'runner-a');
    const paused: string[] = [];
    const { query, pushes } = makeResultQuery({
      type: 'result',
      text: 'persistent gateway error',
      isError: true,
    });

    await processQuery(
      query,
      ERR_ROUTING,
      [],
      'claude',
      undefined,
      buildWorkContinuationPrompt(queued.continuation.task),
      undefined,
      {},
      'runner-a',
      queued.continuation.id,
      (id) => paused.push(id),
    );

    expect(pushes).toHaveLength(0);
    expect(paused).toEqual([queued.continuation.id]);
    expect(getWorkContinuation()).toMatchObject({ id: queued.continuation.id, phase: 'queued' });
  });

  it('does not complete or advance work on an empty result', async () => {
    const queued = queueWorkContinuation('resume after empty result');
    if (!queued.accepted) throw new Error('expected continuation');
    markWorkContinuationRunning(queued.continuation.id, 'runner-a');
    const paused: string[] = [];
    const { query, pushes } = makeResultQuery({ type: 'result', text: null });

    await processQuery(
      query,
      ERR_ROUTING,
      [],
      'claude',
      undefined,
      buildWorkContinuationPrompt(queued.continuation.task),
      undefined,
      {},
      'runner-a',
      queued.continuation.id,
      (id) => paused.push(id),
    );

    expect(pushes).toHaveLength(0);
    expect(paused).toEqual([queued.continuation.id]);
    expect(getWorkContinuation()).toMatchObject({ id: queued.continuation.id, phase: 'queued' });
  });

  // A mid-turn push the SDK MERGES into the running turn yields ONE result for
  // TWO ledger entries, so `archivePrompts` over-counts from then on and the
  // result-path gate never opens again. The poll tick launches on observed
  // provider idleness instead. Pre-fix these two stranded the continuation
  // until the 30-min idle ceiling killed the container.
  describe('merged mid-turn push (ledger over-counts)', () => {
    const deferred = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    it('launches the queued continuation from the poll tick', async () => {
      queueWorkContinuation('finish the migration');
      insertMessage('m-follow', 'chat', { sender: 'Operator', text: 'also check the logs' });
      const followUpPushed = deferred();
      const continuationPushed = deferred();
      const pushes: string[] = [];

      async function* events(): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'sess-1' };
        await followUpPushed.promise;
        // One result answering both the initial prompt and the merged follow-up.
        yield { type: 'result', text: '<message to="chan-1">both handled</message>' };
        await Promise.race([continuationPushed.promise, Bun.sleep(5000)]);
      }
      const query: AgentQuery = {
        push: (m) => {
          pushes.push(m);
          if (m.includes('also check the logs')) followUpPushed.resolve();
          if (m.includes('finish the migration')) continuationPushed.resolve();
        },
        end: () => {},
        abort: () => {},
        events: events(),
      };

      // ultracode/fast must match the query's creation values or the follow-up
      // admission path treats the batch as a mid-turn settings change and ends.
      await processQuery(
        query,
        ERR_ROUTING,
        ['m1'],
        'claude',
        undefined,
        'prompt',
        undefined,
        { ultracode: false, fast: false },
        'runner-a',
      );

      expect(pushes).toHaveLength(2);
      expect(pushes[0]).toContain('also check the logs');
      expect(pushes[1]).toContain('finish the migration');
    }, 30_000);

    it('lets a real inbound win the tick that would otherwise launch it', async () => {
      queueWorkContinuation('finish the migration');
      insertMessage('m-follow', 'chat', { sender: 'Operator', text: 'also check the logs' });
      const followUpPushed = deferred();
      const secondPushed = deferred();
      const pushes: string[] = [];

      async function* events(): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'sess-1' };
        await followUpPushed.promise;
        yield { type: 'result', text: '<message to="chan-1">both handled</message>' };
        insertMessage('m-second', 'chat', { sender: 'Operator', text: 'and the second thing' });
        await Promise.race([secondPushed.promise, Bun.sleep(5000)]);
      }
      const query: AgentQuery = {
        push: (m) => {
          pushes.push(m);
          if (m.includes('also check the logs')) followUpPushed.resolve();
          if (m.includes('and the second thing')) secondPushed.resolve();
        },
        end: () => {},
        abort: () => {},
        events: events(),
      };

      await processQuery(
        query,
        ERR_ROUTING,
        ['m1'],
        'claude',
        undefined,
        'prompt',
        undefined,
        { ultracode: false, fast: false },
        'runner-a',
      );

      expect(pushes).toHaveLength(2);
      expect(pushes[1]).toContain('and the second thing');
      expect(getWorkContinuation()).toMatchObject({ task: 'finish the migration', phase: 'queued' });
    }, 30_000);

    it('launches exactly once when both call sites are live', async () => {
      const queued = queueWorkContinuation('single launch only');
      if (!queued.accepted) throw new Error('expected continuation');
      const pushes: string[] = [];

      async function* events(): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'sess-1' };
        // Ledger is empty here, so the result path launches; the ticks below
        // must not launch it a second time.
        yield { type: 'result', text: '<message to="chan-1">done</message>' };
        await Bun.sleep(1600); // ≥3 poll ticks
      }
      const query: AgentQuery = { push: (m) => pushes.push(m), end: () => {}, abort: () => {}, events: events() };

      await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {}, 'runner-a');

      expect(pushes.filter((p) => p.includes('single launch only'))).toHaveLength(1);
      // Single-flight claim: the record can never be handed out twice.
      expect(markWorkContinuationRunning(queued.continuation.id, 'runner-a')).toBeUndefined();
    }, 30_000);

    // Fleet incident follow-up, 2026-09-10: raising `provider_executing` on
    // an SDK-started `init` (the reaper fix above) stops the task reaper, but
    // `turnIdle` is untouched by that event — only `pushToQuery` and `result`
    // touch it. Left stale-true across the SDK-started turn, the poll tick's
    // turnIdle-gated launch (same danger this describe block is named for)
    // pushes the queued continuation INTO the running turn before it has
    // produced its own result — merged, so its eventual result would answer
    // for two ledger entries at once.
    it('does not push a queued continuation into an SDK-started turn before its own result', async () => {
      const queued = queueWorkContinuation('resume after sdk-started turn');
      if (!queued.accepted) throw new Error('expected continuation');
      const pushes: string[] = [];
      const pushedBeforeSecondResult: boolean[] = [];
      let secondResultYielded = false;

      async function* events(): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'sess-resume' };
        // Empty first turn of a resume: no dispatch, no push, turnIdle → true.
        yield { type: 'result', text: null };
        // The SDK starts the real turn on its own — not a pushToQuery call.
        yield { type: 'init', continuation: 'sess-resume' };
        // Outlast several poll ticks while this turn is nominally still
        // running. Pre-fix, the tick's turnIdle-gated launch fires in here.
        await Bun.sleep(1600); // ≥3 poll ticks
        secondResultYielded = true;
        yield { type: 'result', text: '<internal>done</internal>' };
      }
      const query: AgentQuery = {
        push: (m) => {
          pushes.push(m);
          pushedBeforeSecondResult.push(!secondResultYielded);
        },
        end: () => {},
        abort: () => {},
        events: events(),
      };

      await processQuery(query, ERR_ROUTING, ['m-resume'], 'claude', undefined, 'prompt', undefined, {}, 'runner-a');

      const continuationPushes = pushes
        .map((m, i) => ({ m, before: pushedBeforeSecondResult[i] }))
        .filter((p) => p.m.includes('resume after sdk-started turn'));
      expect(continuationPushes).toHaveLength(1);
      // Must land only once the SDK-started turn produced its own result —
      // never merged into the still-running turn.
      expect(continuationPushes[0]!.before).toBe(false);
    }, 30_000);

    // #617: the same merge from the other side. A turn the CLI started itself
    // has answered, but the task prompt is still queued behind it, so the
    // provider reports queued work and the launch must wait.
    it('does not launch a continuation while the provider reports queued work', async () => {
      const queuedContinuation = queueWorkContinuation('resume after queued prompt');
      if (!queuedContinuation.accepted) throw new Error('expected continuation');
      const pushes: Array<{ m: string; whileQueued: boolean }> = [];
      let queued = true;

      async function* events(): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'sess-queued' };
        // Unprompted: the provider still holds the task prompt.
        yield { type: 'result', text: null, answeredPrompts: [] };
        await Bun.sleep(1600); // ≥3 poll ticks
        queued = false;
        yield { type: 'init', continuation: 'sess-queued' };
        yield { type: 'result', text: '<internal>done</internal>', answeredPrompts: ['p-initial'] };
      }
      const query: AgentQuery = {
        push: (m) => {
          pushes.push({ m, whileQueued: queued });
        },
        initialPromptId: 'p-initial',
        hasQueuedWork: () => queued,
        end: () => {},
        abort: () => {},
        events: events(),
      };

      await processQuery(query, ERR_ROUTING, ['m-queued'], 'claude', undefined, 'prompt', undefined, {}, 'runner-a');

      const launches = pushes.filter((p) => p.m.includes('resume after queued prompt'));
      expect(launches).toHaveLength(1);
      expect(launches[0]!.whileQueued).toBe(false);
    }, 30_000);
  });

  it('explicit cancellation is idempotent', () => {
    queueWorkContinuation('cancel me');
    expect(cancelWorkContinuation()).toBe(true);
    expect(cancelWorkContinuation()).toBe(false);
  });
});

/**
 * Codex round 1, P1 — the routing-level half.
 *
 * A non-retryable provider `error` event ENDS the turn by throwing, so it never
 * reaches the `result` block where a task run's outcome is recorded. Codex
 * terminal failures arrive in exactly that shape, so before this every one of
 * them left NO `task_log` row and therefore no outcome row: a repeatedly
 * failing series could never reach the escalation threshold, and the ledger
 * would say nothing happened.
 *
 * Asserted at the `processQuery` seam rather than on the helper, because the
 * defect was in which code path reaches the helper, not in the helper.
 */
describe('terminal task outcomes reach the run-outcome ledger', () => {
  const TASK_ROUTING = {
    platformId: 'ag-1',
    channelType: 'agent',
    threadId: 'system:tasks:pr-watch-a1b2',
    inReplyTo: 'run-1',
    taskRun: true,
  };

  function taskLogRows(): Array<Record<string, unknown>> {
    return (
      getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as {
        content: string;
      }[]
    ).map((r) => JSON.parse(r.content) as Record<string, unknown>);
  }

  // Codex round 2, P1. `processQuery` is ONE ATTEMPT, not one fire: the outer
  // loop re-invokes it for in-turn recovery. These pin the reporting contract
  // at that seam — an attempt REPORTS its terminal result and writes nothing,
  // so the caller can collapse however many attempts into a single row.
  // Codex round 4, P1 — THE REFRAME.
  //
  // A recurring task that fires again before its long-lived stream is reaped is
  // admitted into the SAME `processQuery` call. The old design held one
  // `taskOutcome` slot behind a `!taskOutcome` guard, so the second fire was
  // dropped entirely and a frequently failing series could sit below the
  // escalation threshold indefinitely — the exact outcome this PR exists to
  // prevent. One slot, N admitted turns.
  //
  // Invariant now: one admitted task turn produces exactly one outcome record.
  it('reports one outcome per admitted task turn, not one per stream', async () => {
    async function* events() {
      yield { type: 'init' as const, continuation: 'c1' };
      yield { type: 'result' as const, text: 'fire one failed', isError: true };
      yield { type: 'result' as const, text: 'fire two failed', isError: true };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };

    const result = await processQuery(query, TASK_ROUTING, ['occ-1'], 'claude', undefined, 'p', undefined, {
      model: 'gpt-6-astra',
    });

    // Only one turn was admitted, so the second result is an in-stream retry of
    // it and coalesces — coalescing is scoped to retries OF a turn.
    expect(result.taskTurns).toHaveLength(1);
    expect(result.taskTurns![0]!.key).toBe('occ-1');
    expect(result.taskTurns![0]!.outcome).toEqual({
      text: 'fire one failed',
      isError: true,
      model: 'gpt-6-astra',
    });
  });

  it('coalesces an outer-loop RETRY of one fire into a single record', async () => {
    // The reframe must not turn one retried fire into several outcome rows —
    // that would trip escalation early on a task that only needed a retry.
    // Coalescing is by turn KEY, and the outer loop re-invokes processQuery
    // with the same admitted batch, so both attempts report the same key.
    // Uses real processQuery output rather than hand-built records, so the
    // keying itself is under test and not just the Map.
    async function attempt(text: string, isError: boolean) {
      async function* events() {
        yield { type: 'init' as const, continuation: 'c1' };
        yield { type: 'result' as const, text, isError };
      }
      const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };
      return processQuery(query, TASK_ROUTING, ['occ-1'], 'claude', undefined, 'p', undefined, {
        model: 'gpt-6-astra',
      });
    }

    const first = await attempt('attempt one failed', true);
    const retry = await attempt('retry succeeded', false);

    // Same fire, so the same key from both attempts.
    expect(first.taskTurns![0]!.key).toBe('occ-1');
    expect(retry.taskTurns![0]!.key).toBe('occ-1');

    // What the caller does: later attempts overwrite earlier ones by key.
    const merged = new Map<string, unknown>();
    for (const t of [...first.taskTurns!, ...retry.taskTurns!]) if (t.outcome) merged.set(t.key, t.outcome);

    expect(merged.size).toBe(1);
    expect(merged.get('occ-1')).toEqual({ text: 'retry succeeded', isError: false, model: 'gpt-6-astra' });
  });

  // THE case this PR is named for: a later occurrence admitted into an
  // ALREADY-RUNNING stream. Two independent `processQuery` calls only prove
  // that different `initialBatchIds` yield different keys — they never touch
  // the follow-up admission path, so they stay green even if its
  // `taskTurns.push` is deleted. That path is exactly where #561's last P1
  // lived: the second fire was dropped and a failing series never crossed the
  // escalation threshold.
  //
  // Verified red-first by removing that push on merged main: this case fails
  // with `['occ-1']` where `['occ-1','occ-2']` is required, while the two
  // separate-stream cases below stay green — which is the whole point.
  it('admits a later occurrence into the RUNNING stream and gives it its own turn', async () => {
    // Pending before the query opens, but NOT in the initial batch — so the
    // only way it can be seen is the in-stream follow-up poll.
    insertMessage('occ-2', 'task', { prompt: 'second fire of the same series' });

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      yield { type: 'result', text: 'first fire failed', isError: true };
      // Outlast ACTIVE_POLL_INTERVAL_MS (500ms) so the follow-up poll runs and
      // admits occ-2 into this same stream.
      await Bun.sleep(1600);
      yield { type: 'result', text: 'second fire failed', isError: true };
    }
    const pushed: string[] = [];
    const query: AgentQuery = {
      push: (m: string) => pushed.push(m),
      end: () => {},
      abort: () => {},
      // Live-controls provider. Without this the poll ENDS the stream to reopen
      // on the resolved settings instead of pushing into it, and the follow-up
      // admission path — the one under test — is never reached.
      applySettings: async () => {},
      events: events(),
    };

    // Settings must match what the follow-up batch resolves to, or the poll
    // treats it as a mid-turn settings change. `ultracode` resolves to `false`,
    // not `undefined`, so an empty object counts as changed.
    const result = await processQuery(query, TASK_ROUTING, ['occ-1'], 'claude', undefined, 'p', undefined, {
      ultracode: false,
    });

    // The follow-up really was admitted into the live stream.
    expect(pushed.join('\n')).toContain('second fire of the same series');
    // ...and it got its OWN turn, rather than coalescing into occ-1's.
    expect(result.taskTurns!.map((t) => t.key)).toEqual(['occ-1', 'occ-2']);
    expect(result.taskTurns![0]!.outcome?.text).toBe('first fire failed');
    expect(result.taskTurns![1]!.outcome?.text).toBe('second fire failed');
  }, 15_000);

  // #617: with prompt ids, one result that answered two admitted fires (the
  // CLI folded the second into the running turn) records BOTH, instead of
  // leaving the later fire with no outcome.
  it('records every fire one merged result answers', async () => {
    insertMessage('occ-2', 'task', { prompt: 'second fire of the same series' });

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      // occ-2 is admitted during this window and folded into the running turn.
      await Bun.sleep(1600);
      yield { type: 'result', text: 'Both fires handled.', answeredPrompts: ['p-initial', 'p-push-1'] };
    }
    let pushes = 0;
    const query: AgentQuery = {
      push: () => `p-push-${++pushes}`,
      initialPromptId: 'p-initial',
      end: () => {},
      abort: () => {},
      applySettings: async () => {},
      events: events(),
    };

    const result = await processQuery(query, TASK_ROUTING, ['occ-1'], 'claude', undefined, 'p', undefined, {
      ultracode: false,
    });

    expect(result.taskTurns!.map((t) => [t.key, t.outcome?.text])).toEqual([
      ['occ-1', 'Both fires handled.'],
      ['occ-2', 'Both fires handled.'],
    ]);
  }, 15_000);

  // #617: a task-block nudge from a turn the CLI started itself used to set
  // `taskBlockNudged`, which then kept the fire's real result out. With prompt
  // ids the real result matches the fire's prompt, and the nudge's own answer
  // matches none.
  it('does not let a nudge from a CLI-started turn keep the real result out', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      // Unprompted, and ending in an undelivered block: this draws the nudge.
      yield { type: 'result', text: '<message to="someone">stray</message>', answeredPrompts: [] };
      yield { type: 'init', continuation: 'c1' };
      yield { type: 'result', text: 'Real answer.', answeredPrompts: ['p-initial'] };
      yield { type: 'result', text: 'Nothing left to send.', answeredPrompts: ['p-push-1'] };
    }
    const pushed: string[] = [];
    const query: AgentQuery = {
      push: (m: string) => {
        pushed.push(m);
        return `p-push-${pushed.length}`;
      },
      initialPromptId: 'p-initial',
      end: () => {},
      abort: () => {},
      events: events(),
    };

    const result = await processQuery(query, TASK_ROUTING, ['occ-1'], 'claude', undefined, 'p', undefined, {});

    expect(pushed.some((m) => m.includes('was not delivered'))).toBe(true);
    expect(result.taskTurns!.map((t) => t.outcome?.text)).toEqual(['Real answer.']);
  });

  // A no-echo result that consumed the fire's prompt draws a task-block
  // nudge, which the CLI runs straight after it, with no idle in between.
  // The nudge's own echo must not clear the held outcome before idle settles
  // the fire's prompt (#619 review, P3-2).
  it('keeps a no-echo outcome held across a nudge the CLI answers before idle', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      yield { type: 'result', text: '<message to="someone">done, echo dropped</message>', answeredPrompts: [] };
      yield { type: 'init', continuation: 'c1' };
      yield { type: 'result', text: 'Nothing left to send.', answeredPrompts: ['p-push-1'] };
      yield { type: 'settled', unansweredPrompts: ['p-initial'] };
    }
    const pushed: string[] = [];
    const query: AgentQuery = {
      push: (m: string) => {
        pushed.push(m);
        return `p-push-${pushed.length}`;
      },
      initialPromptId: 'p-initial',
      end: () => {},
      abort: () => {},
      events: events(),
    };

    const result = await processQuery(query, TASK_ROUTING, ['occ-1'], 'claude', undefined, 'p', undefined, {});

    expect(pushed.some((m) => m.includes('was not delivered'))).toBe(true);
    expect(result.taskTurns!.map((t) => t.outcome?.text)).toEqual([
      '<message to="someone">done, echo dropped</message>',
    ]);
  });

  it('a batch after a live change is compared against the LIVE settings, not the creation snapshot', async () => {
    // Round-2 P2, the same seam from the other side. `querySettings` is the
    // immutable creation snapshot, so once a live change lands it no longer
    // describes the stream. A later batch whose settings happen to equal that
    // stale snapshot then reads as "unchanged", applySettings is skipped, and
    // the turn silently keeps the PREVIOUS batch's settings.
    //
    // Here the query is created at xhigh, a task fire moves it to medium live,
    // and a second batch wants xhigh again — equal to the creation snapshot,
    // different from the stream. It must be applied.
    insertMessage('occ-2', 'task', { prompt: 'second fire', flagIntent: { turnEffort: 'medium' } });

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      yield { type: 'result', text: 'first fire', isError: true };
      // occ-2 is admitted during this window and moves the LIVE stream to
      // medium. The creation snapshot still says xhigh.
      await Bun.sleep(1600);
      // Staged from inside the stream so it lands in a SECOND follow-up batch
      // rather than being merged into occ-2's. It wants xhigh again — equal to
      // the stale creation snapshot, different from the live stream.
      insertMessage('occ-3', 'task', { prompt: 'third fire', flagIntent: { turnEffort: 'xhigh' } });
      yield { type: 'result', text: 'second fire', isError: true };
      await Bun.sleep(1600);
      yield { type: 'result', text: 'third fire', isError: true };
    }
    const efforts: Array<string | undefined> = [];
    const query: AgentQuery = {
      push: () => {},
      end: () => {},
      abort: () => {},
      applySettings: async (sIn) => {
        efforts.push(sIn.effort);
      },
      events: events(),
    };

    await processQuery(query, TASK_ROUTING, ['occ-1'], 'claude', undefined, 'p', undefined, {
      effort: 'xhigh',
      ultracode: false,
    });

    // Pre-fix: ['medium'] — occ-3's xhigh equalled the stale CREATION
    // snapshot, so the comparison said "unchanged" and the stream was left on
    // medium, silently running occ-3 at the previous fire's effort.
    expect(efforts).toEqual(['medium', 'xhigh']);
  }, 15_000);

  it('defers an immutable runtime-context restart until the active query is idle', async () => {
    insertMessage('occ-2', 'task', { prompt: 'second fire', flagIntent: { turnEffort: 'medium' } });
    let firstResult = false;

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      // Several follow-up polls see occ-2 while this turn is still active.
      // An eager end() would close Claude's live control channel here.
      await Bun.sleep(1600);
      firstResult = true;
      yield { type: 'result', text: 'first fire', isError: true };
      // The next poll reaches the idle boundary and can now end safely.
      await Bun.sleep(1600);
    }
    let ended = false;
    let endedAfterResult = false;
    let applied = false;
    const query: AgentQuery = {
      push: () => {},
      end: () => {
        ended = true;
        endedAfterResult = firstResult;
      },
      abort: () => {},
      applySettings: async () => {
        applied = true;
      },
      requiresRestartForRuntimeContext: true,
      events: events(),
    };

    await processQuery(query, TASK_ROUTING, ['occ-1'], 'claude', undefined, 'p', undefined, {
      effort: 'xhigh',
      ultracode: false,
    });

    expect(ended).toBe(true);
    expect(endedAfterResult).toBe(true);
    expect(applied).toBe(false);
    expect(getPendingMessages().map((message) => message.id)).toContain('occ-2');
  }, 15_000);

  it('defers an immutable runtime-context restart while background work is live, and ends once it drains', async () => {
    insertMessage('occ-2', 'task', { prompt: 'second fire', flagIntent: { turnEffort: 'medium' } });
    let live = 1;
    let drained = false;

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      yield { type: 'result', text: 'delegated, waiting', isError: true };
      // Idle boundary, but a background worker is still running inside the
      // CLI: several polls see occ-2 here and must not end() — the open input
      // is what keeps that worker alive.
      await Bun.sleep(1600);
      // The worker finishes; the CLI's idle report says nothing is live.
      live = 0;
      drained = true;
      yield { type: 'background_work', live: 0 };
      // Now the next poll may end safely.
      await Bun.sleep(1600);
    }
    let ended = false;
    let endedAfterDrain = false;
    const query: AgentQuery = {
      push: () => {},
      end: () => {
        ended = true;
        endedAfterDrain = drained;
      },
      abort: () => {},
      applySettings: async () => {},
      hasBackgroundWork: () => live > 0,
      requiresRestartForRuntimeContext: true,
      events: events(),
    };

    await processQuery(query, TASK_ROUTING, ['occ-1'], 'claude', undefined, 'p', undefined, {
      effort: 'xhigh',
      ultracode: false,
    });

    expect(ended).toBe(true);
    expect(endedAfterDrain).toBe(true);
    expect(getPendingMessages().map((message) => message.id)).toContain('occ-2');
  }, 15_000);

  it('does not close immutable runtime context during asynchronous result handling', async () => {
    insertMessage('occ-2', 'task', { prompt: 'second fire', flagIntent: { turnEffort: 'medium' } });
    let beginOutcome!: () => void;
    const outcomeStarted = new Promise<void>((resolve) => {
      beginOutcome = resolve;
    });
    let releaseOutcome!: () => void;
    const outcomeReleased = new Promise<void>((resolve) => {
      releaseOutcome = resolve;
    });
    let nudgePushed = false;
    let ended = false;
    let endedBeforeNudge = false;

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      // A task-run message block requires a corrective nudge, but its outcome
      // write below intentionally holds result handling open first.
      yield {
        type: 'result',
        text: '<message to="someone">not allowed for a task run</message>',
        answeredPrompts: ['p-initial'],
      };
      await Bun.sleep(700);
      yield { type: 'result', text: 'nudge handled', answeredPrompts: ['p-nudge'] };
      await Bun.sleep(700);
    }
    const query: AgentQuery = {
      initialPromptId: 'p-initial',
      push: () => {
        nudgePushed = true;
        return 'p-nudge';
      },
      end: () => {
        ended = true;
        endedBeforeNudge = !nudgePushed;
      },
      abort: () => {},
      applySettings: async () => {},
      requiresRestartForRuntimeContext: true,
      events: events(),
    };

    const run = processQuery(
      query,
      TASK_ROUTING,
      ['occ-1'],
      'claude',
      undefined,
      'p',
      undefined,
      { effort: 'xhigh', ultracode: false },
      undefined,
      undefined,
      undefined,
      'unknown',
      async () => {
        beginOutcome();
        await outcomeReleased;
      },
    );

    await outcomeStarted;
    // The interval has a chance to observe the pending -e row, but must not
    // close input before the held task outcome can lead to its corrective push.
    await Bun.sleep(700);
    expect(ended).toBe(false);
    releaseOutcome();
    await run;

    expect(nudgePushed).toBe(true);
    expect(ended).toBe(true);
    expect(endedBeforeNudge).toBe(false);
    expect(getPendingMessages().map((message) => message.id)).toContain('occ-2');
  }, 15_000);

  it('a task admitted mid-turn does NOT retarget the running stream', async () => {
    // Round-5 P1, and the regression guard for this whole class.
    //
    // `keep` on the follow-up path is the newly-admitted SUB-BATCH, not the
    // turn. A scheduled row becoming due while an interactive query is still
    // streaming makes it a lone task row — so a task-wake predicate reads
    // true, and suppressing on it retargets a turn that may be a HUMAN's,
    // mid-answer, off their own model and effort.
    //
    // That is the exact inverse of the bug this PR set out to fix: we began
    // with "tasks must not inherit chat settings" and briefly shipped "tasks
    // steal chat settings". Scheduled-task suppression therefore applies only
    // where a task wake OPENS a query; a task joining a running turn inherits
    // that turn's settings, which is also the pre-existing behaviour.
    setStickyModel('claude-opus-5[1m]');
    setStickyEffort('xhigh');
    insertMessage('occ-2', 'task', { prompt: 'a scheduled fire that came due mid-answer' });

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      yield { type: 'result', text: 'partial', isError: false };
      await Bun.sleep(1600);
      yield { type: 'result', text: 'done', isError: false };
    }
    const applied: Array<Record<string, unknown>> = [];
    let ended = false;
    const query: AgentQuery = {
      push: () => {},
      end: () => {
        ended = true;
      },
      abort: () => {},
      applySettings: async (sIn) => {
        applied.push(sIn);
      },
      resolvedModel: 'claude-opus-5[1m]',
      events: events(),
    };

    // The query was opened for a human turn on their sticky model/effort.
    await processQuery(query, TASK_ROUTING, ['m1'], 'claude', undefined, 'p', undefined, {
      model: 'claude-opus-5[1m]',
      effort: 'xhigh',
      ultracode: false,
    });

    // On 6dd936b9a: applied === [{ model: undefined, effort: undefined, … }],
    // i.e. the human's live turn was dragged onto the group default.
    expect(applied).toEqual([]);
    expect(ended).toBe(false);
  }, 15_000);

  it('drops a primary-provider task pin admitted into a fallback stream', async () => {
    // This row was valid when it was scheduled for its Codex primary. The
    // fallback now runs Claude, so feeding its gpt-* pin to applySettings
    // would make the fallback stream invalid rather than target-native.
    insertMessage('occ-fallback', 'task', {
      prompt: 'a scheduled fire that came due during fallback',
      flagIntent: { turnModel: 'gpt-6-astra', turnEffort: 'medium' },
    });

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      yield { type: 'result', text: 'partial', isError: false };
      await Bun.sleep(1600);
      yield { type: 'result', text: 'done', isError: false };
    }
    const applied: Array<Record<string, unknown>> = [];
    const pushed: string[] = [];
    const query: AgentQuery = {
      push: (message) => {
        pushed.push(message);
      },
      end: () => {},
      abort: () => {},
      applySettings: async (settings) => {
        applied.push(settings);
      },
      events: events(),
    };

    // Fallback model/effort live in the provider's fallback config, not the
    // per-turn input. An absent turn override is therefore the correct
    // unchanged baseline for this fallback query.
    await processQuery(
      query,
      TASK_ROUTING,
      ['m1'],
      'claude',
      undefined,
      'p',
      undefined,
      { ultracode: false },
      undefined,
      undefined,
      undefined,
      'unknown',
      undefined,
      { ignoreTaskFlagIntents: true },
    );

    expect(pushed.join('\n')).toContain('a scheduled fire that came due during fallback');
    expect(applied).toEqual([]);
  }, 15_000);

  it('keeps two separate fires apart even though they share a series', async () => {
    async function fire(occurrenceId: string) {
      async function* events() {
        yield { type: 'init' as const, continuation: 'c1' };
        yield { type: 'result' as const, text: `${occurrenceId} failed`, isError: true };
      }
      const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };
      return processQuery(query, TASK_ROUTING, [occurrenceId], 'claude', undefined, 'p', undefined, {
        model: 'gpt-6-astra',
      });
    }

    const a = await fire('occ-1');
    const b = await fire('occ-2');
    const merged = new Map<string, unknown>();
    for (const t of [...a.taskTurns!, ...b.taskTurns!]) if (t.outcome) merged.set(t.key, t.outcome);

    // Distinct occurrences must NOT coalesce — that is the under-count this
    // whole feature is trying to avoid.
    expect([...merged.keys()]).toEqual(['occ-1', 'occ-2']);
  });

  it('an attempt REPORTS its outcome and writes no row itself', async () => {
    async function* events() {
      yield { type: 'init' as const, continuation: 'c1' };
      yield { type: 'result' as const, text: 'watched, nothing new' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };

    const result = await processQuery(query, TASK_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {
      model: 'claude-fable-5-1',
    });

    expect(result.taskTurns).toHaveLength(1);
    expect(result.taskTurns![0]!.outcome).toEqual({
      text: 'watched, nothing new',
      isError: false,
      model: 'claude-fable-5-1',
    });
    // The write belongs to the fire, not the attempt.
    expect(taskLogRows()).toHaveLength(0);
  });

  it('reports no outcome when the attempt throws, so the caller can retry it', async () => {
    async function* events() {
      yield { type: 'init' as const, continuation: 'c1' };
      yield { type: 'error' as const, message: 'codex_system_error', retryable: false };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };

    await expect(
      processQuery(query, TASK_ROUTING, ['m1'], 'codex', undefined, 'prompt', undefined, { model: 'gpt-6-astra' }),
    ).rejects.toThrow();
    // Nothing written: a recovery attempt may still make this fire succeed.
    expect(taskLogRows()).toHaveLength(0);
  });

  it('records a non-retryable provider error as a failed fire', async () => {
    async function* events() {
      yield { type: 'init' as const, continuation: 'c1' };
      yield {
        type: 'error' as const,
        message: "There's an issue with the selected model (gpt-6-astra).",
        retryable: false,
        classification: 'system_error',
      };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };

    // Round 1 asserted a row here. Round 2 moved the write to the fire level,
    // so the attempt must throw WITHOUT writing — the outer loop may recover.
    // The failure is still recorded, by the fire-level `finally`; see
    // `synthesises a failure when every attempt threw` below.
    await expect(
      processQuery(query, TASK_ROUTING, ['m1'], 'codex', undefined, 'prompt', undefined, { model: 'gpt-6-astra' }),
    ).rejects.toThrow(/issue with the selected model/);
    expect(taskLogRows()).toHaveLength(0);
  });

  it('records a terminal result that carried no text', async () => {
    async function* events() {
      yield { type: 'init' as const, continuation: 'c1' };
      yield { type: 'result' as const, text: null };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };

    const result = await processQuery(query, TASK_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, {
      model: 'claude-fable-5-1',
    });

    // Still observed — a blank success is what resets a stale streak — but
    // reported rather than written.
    expect(result.taskTurns![0]!.outcome).toEqual({ text: '', isError: false, model: 'claude-fable-5-1' });
    expect(taskLogRows()).toHaveLength(0);
  });
});
