/**
 * Scheduled task fires start the provider with no resumed continuation by
 * default; a thread-bound, --continuous, dispatch or retried fire, or any batch
 * holding a non-task row, resumes exactly as before.
 * Drives the real `runPollLoop` against a provider that records the
 * continuation each query was handed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import type { MessageInRow } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, QueryInput } from './providers/types.js';
import { runPollLoop, selectInTurnFollowUps } from './poll-loop.js';
import { isFreshContextTaskBatch, taskRowFiresFresh } from './fresh-context-task.js';
import { queueWorkContinuation } from './modules/mailbox/index.js';

class RecordingProvider extends MockProvider {
  readonly continuations: Array<string | undefined> = [];
  query(input: QueryInput): AgentQuery {
    this.continuations.push(input.continuation);
    return super.query(input);
  }
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertRow(id: string, kind: 'task' | 'chat', content: object, threadId: string | null = null): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content, trigger)
       VALUES (?, ?, ?, 'pending', 'chan-1', 'discord', ?, ?, 1)`,
    )
    .run(id, kind, new Date().toISOString(), threadId, JSON.stringify(content));
}

async function waitForQueries(provider: RecordingProvider, n: number, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (provider.continuations.length < n) {
    if (Date.now() > deadline) throw new Error(`provider queried ${provider.continuations.length} of ${n} times`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runOneBatch(provider: RecordingProvider): Promise<void> {
  const controller = new AbortController();
  const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal });
  try {
    await waitForQueries(provider, 1);
    // Let the turn finish so the new continuation is persisted.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    controller.abort();
    await loop.catch(() => {});
  }
}

describe('scheduled task fires', () => {
  it('a parent-channel fire with no flag starts with no resumed continuation', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('t1', 'task', { prompt: 'check the watch' });
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBeUndefined();
    // The fresh turn's own session is what gets stored, not the old one.
    expect(getContinuation('mock')).toStartWith('mock-session-');
  });

  it('a thread-bound fire resumes the stored continuation', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('t1', 'task', { prompt: 'post in the thread' }, 'thread-7');
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBe('prior-session');
  });

  it('a --continuous fire resumes the stored continuation', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('t1', 'task', { prompt: 'compare with last time', continuous: true });
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBe('prior-session');
  });

  it('a retry of an interrupted fire resumes the session that attempt stored', async () => {
    setContinuation('mock', 'interrupted-attempt-session');
    insertRow('t1', 'task', { prompt: 'check the watch' });
    getInboundDb().prepare('UPDATE messages_in SET tries = 1 WHERE id = ?').run('t1');
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBe('interrupted-attempt-session');
  });

  it('a fire that comes due while the previous query is still open ends it and starts fresh', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('t1', 'task', { prompt: 'first fire' });
    const provider = new RecordingProvider();
    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal });
    try {
      await waitForQueries(provider, 1);
      // The mock keeps its stream open after the result, as the real providers do.
      await new Promise((resolve) => setTimeout(resolve, 300));
      insertRow('t2', 'task', { prompt: 'second fire' });
      await waitForQueries(provider, 2, 8000);
      expect(provider.continuations).toEqual([undefined, undefined]);
    } finally {
      controller.abort();
      await loop.catch(() => {});
    }
  });

  it('a fire that comes due while a continue_work is queued resumes, so that work keeps its conversation', async () => {
    setContinuation('mock', 'prior-session');
    queueWorkContinuation('finish the report from the last fire');
    insertRow('t1', 'task', { prompt: 'check the watch' });
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBe('prior-session');
  });

  it('a fire that comes due while a wait wake is still pending resumes', async () => {
    setContinuation('mock', 'prior-session');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, process_after, content, trigger)
         VALUES ('schedule-wake-w1', 'chat', ?, 'pending', ?, '{"text":"[system] check back"}', 1)`,
      )
      .run(new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString());
    insertRow('t1', 'task', { prompt: 'check the watch' });
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBe('prior-session');
  });

  it('a fire that comes due mid-turn is held, the turn is not ended, and the fire runs fresh once idle', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('t1', 'task', { prompt: 'first fire' });
    const continuations: Array<string | undefined> = [];
    let resultSeen = false;
    const endCalls: boolean[] = [];
    let queries = 0;
    const provider = {
      supportsNativeSlashCommands: false,
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      query: (input: QueryInput): AgentQuery => {
        continuations.push(input.continuation);
        const n = ++queries;
        let endedResolve: () => void = () => {};
        const ended = new Promise<void>((resolve) => (endedResolve = resolve));
        async function* events() {
          yield { type: 'init' as const, continuation: `session-${n}` };
          if (n === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
          resultSeen = true;
          yield { type: 'result' as const, text: `fire ${n} done` };
          await ended;
        }
        return {
          push: () => {},
          end: () => {
            if (n === 1) endCalls.push(resultSeen);
            endedResolve();
          },
          abort: () => endedResolve(),
          events: events(),
        };
      },
    };
    const controller = new AbortController();
    const loop = runPollLoop({
      provider: provider as never,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });
    try {
      const deadline = Date.now() + 10_000;
      while (continuations.length < 1) await new Promise((resolve) => setTimeout(resolve, 20));
      // Mid-turn: the first query has not produced its result yet.
      insertRow('t2', 'task', { prompt: 'second fire' });
      while (continuations.length < 2) {
        if (Date.now() > deadline) throw new Error('second fire never ran');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The first fire reset; the held second fire started fresh too, not in session-1.
      expect(continuations).toEqual([undefined, undefined]);
      expect(endCalls.length).toBeGreaterThan(0);
      expect(endCalls.every((afterResult) => afterResult)).toBe(true);
    } finally {
      controller.abort();
      await loop.catch(() => {});
    }
  }, 15_000);

  it('a chat row batched with a fire keeps the conversation', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('t1', 'task', { prompt: 'check the watch' });
    insertRow('c1', 'chat', { sender: 'Alice', text: 'and what about yesterday?' });
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBe('prior-session');
  });

  it('a chat-only batch keeps the conversation', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('c1', 'chat', { sender: 'Alice', text: 'hello again' });
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBe('prior-session');
  });
});

describe('isFreshContextTaskBatch', () => {
  const row = (kind: string, content: object | string, threadId: string | null = null): MessageInRow =>
    ({
      id: 'x',
      kind,
      thread_id: threadId,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    }) as MessageInRow;

  it('is true only when every non-system row is a task that fires fresh', () => {
    expect(isFreshContextTaskBatch([row('task', { prompt: 'p' })])).toBe(true);
    expect(isFreshContextTaskBatch([row('system', { text: 'recall' }), row('task', { prompt: 'p' })])).toBe(true);
    expect(isFreshContextTaskBatch([row('task', { prompt: 'p' }), row('chat', { text: 'hi' })])).toBe(false);
    expect(isFreshContextTaskBatch([row('system', { text: 'recall' })])).toBe(false);
    expect(isFreshContextTaskBatch([])).toBe(false);
  });

  it('keeps thread-bound, --continuous, dispatch and retried fires, and unreadable rows, continuous', () => {
    expect(taskRowFiresFresh(row('task', { prompt: 'p' }, 'thread-7'))).toBe(false);
    expect(taskRowFiresFresh(row('task', { prompt: 'p', continuous: true }))).toBe(false);
    expect(taskRowFiresFresh(row('task', { prompt: 'p', continuous: false }))).toBe(true);
    expect(taskRowFiresFresh(row('task', { prompt: 'p', dispatch: { contextKey: 'k', eventKey: 'e' } }))).toBe(false);
    expect(taskRowFiresFresh({ ...row('task', { prompt: 'p' }), tries: 1 })).toBe(false);
    expect(taskRowFiresFresh(row('task', 'not json'))).toBe(false);
    expect(taskRowFiresFresh(row('chat', { text: 'hi' }))).toBe(false);
  });
});

describe('selectInTurnFollowUps', () => {
  it('leaves a fresh task fire pending instead of pushing it into the running conversation', () => {
    const task = (id: string, content: object): MessageInRow =>
      ({ id, kind: 'task', trigger: 1, thread_id: null, content: JSON.stringify(content) }) as MessageInRow;
    const admitted = selectInTurnFollowUps([
      task('fresh', { prompt: 'p' }),
      task('kept', { prompt: 'p', continuous: true }),
    ]);
    expect(admitted.map((m) => m.id)).toEqual(['kept']);
    expect(selectInTurnFollowUps([task('fresh', { prompt: 'p' })])).toEqual([]);
  });

  it('admits a fire into the running conversation while the session holds open work', () => {
    queueWorkContinuation('finish the report');
    const task = { id: 'fresh', kind: 'task', trigger: 1, thread_id: null, content: '{"prompt":"p"}' } as MessageInRow;
    expect(selectInTurnFollowUps([task]).map((m) => m.id)).toEqual(['fresh']);
  });
});
