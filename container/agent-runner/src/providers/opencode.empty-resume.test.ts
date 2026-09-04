import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  EMPTY_RESUME_ERROR,
  isEmptyOpenCodeResume,
  OpenCodeProvider,
  type OpenCodeRuntimeDeps,
  type OpenCodeRuntimeHandle,
} from './opencode.js';
import type { ProviderEvent } from './types.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';

// The empty-turn fallback reads session state through the outbound session DB
// (shouldPostInfraWarning), so every turn that ends without text needs one.
beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

type Ev = { type: string; properties: Record<string, unknown> };

/**
 * Drives `query()` without spawning `opencode serve`: a scripted SSE stream, a
 * session factory that hands out ids in order, and a record of the prompts each
 * session received.
 */
function makeRuntime(script: Ev[][], sessionIds: string[]) {
  const prompts: Array<{ sessionId: string; parts: unknown[] }> = [];
  const created: string[] = [];
  let turnIndex = 0;
  let nextSession = 0;

  async function* stream(): AsyncGenerator<Ev, void, void> {
    while (turnIndex < script.length) {
      const events = script[turnIndex]!;
      turnIndex += 1;
      for (const ev of events) yield ev;
    }
    // Nothing left to replay; park so the generator never reports `done` (which
    // the provider treats as a stream failure).
    await new Promise(() => {});
  }

  const runtime: OpenCodeRuntimeHandle = {
    client: {
      session: {
        async create() {
          const id = sessionIds[nextSession] ?? `overflow-${nextSession}`;
          nextSession += 1;
          created.push(id);
          return { data: { id } };
        },
        async promptAsync(params) {
          prompts.push({ sessionId: params.path.id, parts: params.body.parts });
          return {};
        },
      },
      async postSessionIdPermissionsPermissionId() {
        return {};
      },
    },
    stream: stream() as OpenCodeRuntimeHandle['stream'],
    questionClient: {
      question: {
        async reply() {
          return { data: true };
        },
        async list() {
          return { data: [] };
        },
      },
    },
  };

  const deps: OpenCodeRuntimeDeps = { getRuntime: async () => runtime };
  return { deps, prompts, created };
}

function idle(sessionID: string): Ev {
  return { type: 'session.idle', properties: { sessionID } };
}

function assistantEnvelope(sessionID: string, id: string): Ev {
  // OpenCode opens the assistant record when the turn starts, so this alone is
  // the quiet-idle signature — an envelope with nothing under it.
  return { type: 'message.updated', properties: { info: { id, role: 'assistant', sessionID } } };
}

function textPart(sessionID: string, messageID: string, id: string, text: string): Ev {
  return { type: 'message.part.updated', properties: { part: { id, type: 'text', messageID, sessionID, text } } };
}

function toolPart(sessionID: string, messageID: string, id: string): Ev {
  return { type: 'message.part.updated', properties: { part: { id, type: 'tool', messageID, sessionID } } };
}

function assistantWithUsage(
  sessionID: string,
  id: string,
  tokens: { input: number; output: number },
  cost: number,
): Ev {
  return {
    type: 'message.updated',
    properties: {
      info: { id, role: 'assistant', sessionID, providerID: 'nvidia', modelID: 'test-model', cost, tokens },
    },
  };
}

function newProvider(deps: OpenCodeRuntimeDeps): OpenCodeProvider {
  const provider = new OpenCodeProvider({}, deps);
  provider.registerMemorySessionHook({ command: 'noop', matcher: undefined } as never);
  return provider;
}

async function drainUntilResult(events: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const seen: ProviderEvent[] = [];
  for await (const ev of events) {
    if (ev.type === 'activity') continue;
    seen.push(ev);
    if (ev.type === 'result') break;
  }
  return seen;
}

/** Drains until the generator throws, returning the error. Fails if it does not. */
async function drainExpectingThrow(events: AsyncGenerator<ProviderEvent>): Promise<Error> {
  try {
    for await (const ev of events) {
      if (ev.type === 'result') break;
    }
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the query to raise a stale-session error, but it completed');
}

describe('isEmptyOpenCodeResume', () => {
  it('test_oc_resume_only_resumes_recover: a fresh session that stays dry is never recovered', () => {
    // A brand-new session with no output is a model/tools miss, not a dead
    // continuation — recovering it would double the spend for the same silence.
    expect(isEmptyOpenCodeResume({ resumedExistingSession: false, sawAssistantWork: false })).toBe(false);
  });

  it('test_oc_resume_dead_continuation_detected: a silent resume is a dead continuation', () => {
    expect(isEmptyOpenCodeResume({ resumedExistingSession: true, sawAssistantWork: false })).toBe(true);
  });

  it('test_oc_resume_work_blocks_recovery: any assistant work keeps the session', () => {
    expect(isEmptyOpenCodeResume({ resumedExistingSession: true, sawAssistantWork: true })).toBe(false);
  });
});

describe('OpenCodeProvider — empty-resume recovery', () => {
  it('test_oc_resume_raises_stale_session: a silent resume raises rather than replaying inline', async () => {
    // Recovery belongs to the poll-loop's stale-session branch, which clears the
    // continuation, resets the provider context, re-arms the memory bootstrap
    // and retries with a recap from the per-session DB. Replaying inline here
    // would skip all four and lose the conversation history.
    const resumed = 'sess-dead';
    const { deps, prompts, created } = makeRuntime(
      [[assistantEnvelope(resumed, 'm1'), idle(resumed)]],
      ['sess-should-not-be-used'],
    );

    const provider = newProvider(deps);
    const query = provider.query({ prompt: 'hello', continuation: resumed, cwd: '/workspace/agent' });
    const err = await drainExpectingThrow(query.events);

    expect(err.message).toContain(EMPTY_RESUME_ERROR);
    expect(err.message).toContain(resumed);
    // No fresh session is created here, and the dead one was prompted exactly once.
    expect(created).toEqual([]);
    expect(prompts.map((p) => p.sessionId)).toEqual([resumed]);
    query.abort();
  });

  it('test_oc_resume_error_is_session_invalid: the runner classifies that error as a stale session', () => {
    // This is the whole contract with the poll-loop: `isSessionInvalid` is what
    // selects the recap-bearing recovery branch. If the marker and the matcher
    // ever drift apart, the turn surfaces as a plain error instead.
    const provider = newProvider(makeRuntime([], []).deps);
    expect(provider.isSessionInvalid(new Error(`${EMPTY_RESUME_ERROR} (session sess-dead)`))).toBe(true);
    // Unrelated failures still classify as they did.
    expect(provider.isSessionInvalid(new Error('some unrelated provider failure'))).toBe(false);
  });

  it('test_oc_resume_clears_active_session: the dead id is dropped so nothing resumes it again', async () => {
    const resumed = 'sess-dead';
    const { deps } = makeRuntime([[assistantEnvelope(resumed, 'm1'), idle(resumed)]], ['sess-unused']);
    const provider = newProvider(deps);
    const query = provider.query({ prompt: 'hello', continuation: resumed, cwd: '/workspace/agent' });
    await drainExpectingThrow(query.events);
    expect((provider as unknown as { activeSessionId?: string }).activeSessionId).toBeUndefined();
    query.abort();
  });

  it('test_oc_resume_tool_only_turn_is_work: a turn that produced a tool part is not recovered', async () => {
    // The assistant said nothing but did something. Recovering would discard the
    // history for a turn that genuinely ran.
    const resumed = 'sess-live';
    const { deps, prompts, created } = makeRuntime(
      [[assistantEnvelope(resumed, 'm1'), toolPart(resumed, 'm1', 'p1'), idle(resumed)]],
      ['sess-should-not-be-used'],
    );

    const query = newProvider(deps).query({ prompt: 'hello', continuation: resumed, cwd: '/workspace/agent' });
    const seen = await drainUntilResult(query.events);

    expect(created).toEqual([]);
    expect(prompts.map((p) => p.sessionId)).toEqual([resumed]);
    expect(seen.filter((e) => e.type === 'init')).toHaveLength(1);
    expect(seen.at(-1)?.type).toBe('result');
    query.abort();
  });

  it('test_oc_resume_errored_turn_is_work: a provider error on the assistant record is not recovered', async () => {
    // An errored turn marks a LIVE session whose request failed. Recovering it
    // would throw away the history and bury the error.
    const resumed = 'sess-live';
    const { deps } = makeRuntime(
      [
        [
          {
            type: 'message.updated',
            properties: { info: { id: 'm1', role: 'assistant', sessionID: resumed, error: { name: 'ProviderError' } } },
          },
          idle(resumed),
        ],
      ],
      ['sess-should-not-be-used'],
    );

    const query = newProvider(deps).query({ prompt: 'hello', continuation: resumed, cwd: '/workspace/agent' });
    const seen = await drainUntilResult(query.events);
    expect(seen.at(-1)?.type).toBe('result');
    query.abort();
  });

  it('test_oc_resume_fresh_session_not_recovered: an opening query with no continuation never raises', async () => {
    const fresh = 'sess-new';
    const { deps, prompts, created } = makeRuntime(
      [[assistantEnvelope(fresh, 'm1'), idle(fresh)]],
      [fresh, 'sess-should-not-be-used'],
    );

    const query = newProvider(deps).query({ prompt: 'hello', cwd: '/workspace/agent' });
    const seen = await drainUntilResult(query.events);

    // Exactly one session created (the opening one) and one prompt sent — the
    // dry turn surfaces through the empty-turn warning, not as an error.
    expect(created).toEqual([fresh]);
    expect(prompts).toHaveLength(1);
    expect(seen.at(-1)?.type).toBe('result');
    query.abort();
  });

  it("test_oc_resume_subagent_usage_still_summed: a subagent session's spend stays in the turn usage", async () => {
    // sumOpenCodeTurnUsage deliberately sums EVERY assistant message the turn
    // saw, subagents included, because those are real spend. The session
    // narrowing the recovery needs must not narrow that sum.
    const own = 'sess-own';
    const sub = 'sess-subagent';
    const { deps } = makeRuntime(
      [
        [
          assistantWithUsage(own, 'm1', { input: 100, output: 10 }, 0.01),
          textPart(own, 'm1', 'p1', 'answer'),
          assistantWithUsage(sub, 'm2', { input: 500, output: 50 }, 0.05),
          idle(own),
        ],
      ],
      [own],
    );

    const query = newProvider(deps).query({ prompt: 'hello', cwd: '/workspace/agent' });
    const seen = await drainUntilResult(query.events);
    const result = seen.at(-1) as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.usage).toMatchObject({ inputTokens: 600, outputTokens: 60 });
    expect(result.steps).toBe(2);
    query.abort();
  });

  it("test_oc_resume_foreign_session_work_does_not_count: another session's output does not keep a dead resume", async () => {
    // A concurrent session producing parts says nothing about whether THIS
    // continuation is alive, so it must not suppress the recovery.
    const resumed = 'sess-dead';
    const other = 'sess-other';
    const { deps } = makeRuntime(
      [
        [
          assistantEnvelope(resumed, 'm1'),
          assistantEnvelope(other, 'm2'),
          textPart(other, 'm2', 'p1', 'someone else'),
          idle(resumed),
        ],
      ],
      ['sess-unused'],
    );

    const query = newProvider(deps).query({ prompt: 'hello', continuation: resumed, cwd: '/workspace/agent' });
    const err = await drainExpectingThrow(query.events);
    expect(err.message).toContain(EMPTY_RESUME_ERROR);
    query.abort();
  });
});
