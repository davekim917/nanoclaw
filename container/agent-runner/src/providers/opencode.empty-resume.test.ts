import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
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

describe('isEmptyOpenCodeResume', () => {
  it('test_oc_resume_only_resumes_fall_back: a fresh session that stays dry is never replayed', () => {
    // A brand-new session with no output is a model/tools miss, not a dead
    // continuation — replaying it would double the spend for the same silence.
    expect(
      isEmptyOpenCodeResume({ resumedExistingSession: false, alreadyFellBack: false, sawAssistantWork: false }),
    ).toBe(false);
  });

  it('test_oc_resume_falls_back_once: at most one fallback per query', () => {
    expect(
      isEmptyOpenCodeResume({ resumedExistingSession: true, alreadyFellBack: false, sawAssistantWork: false }),
    ).toBe(true);
    expect(isEmptyOpenCodeResume({ resumedExistingSession: true, alreadyFellBack: true, sawAssistantWork: false })).toBe(
      false,
    );
  });

  it('test_oc_resume_work_blocks_fallback: any assistant work keeps the session', () => {
    expect(isEmptyOpenCodeResume({ resumedExistingSession: true, alreadyFellBack: false, sawAssistantWork: true })).toBe(
      false,
    );
  });
});

describe('OpenCodeProvider — empty-resume fallback', () => {
  it('test_oc_resume_replays_on_fresh_session: a silent resume is retried on a new session', async () => {
    const resumed = 'sess-dead';
    const fresh = 'sess-fresh';
    const { deps, prompts, created } = makeRuntime(
      [
        // Turn 1 on the resumed session: bare envelope, then idle. No parts.
        [assistantEnvelope(resumed, 'm1'), idle(resumed)],
        // Turn 2 on the replacement session: a real answer.
        [
          assistantEnvelope(fresh, 'm2'),
          textPart(fresh, 'm2', 'p1', 'recovered answer'),
          idle(fresh),
        ],
      ],
      [fresh],
    );

    const query = newProvider(deps).query({ prompt: 'hello', continuation: resumed, cwd: '/workspace/agent' });
    const seen = await drainUntilResult(query.events);

    // The dead session's id is announced first, then the replacement's.
    expect(seen.filter((e) => e.type === 'init')).toEqual([
      { type: 'init', continuation: resumed },
      { type: 'init', continuation: fresh },
    ]);
    expect(created).toEqual([fresh]);
    expect(prompts.map((p) => p.sessionId)).toEqual([resumed, fresh]);
    const result = seen.at(-1);
    expect(result?.type).toBe('result');
    expect(result && 'text' in result ? result.text : undefined).toBe('recovered answer');
    query.abort();
  });

  it('test_oc_resume_replay_prompt_wrapped_once: the replay is composed, not double-wrapped', async () => {
    const resumed = 'sess-dead';
    const fresh = 'sess-fresh';
    const { deps, prompts } = makeRuntime(
      [
        [assistantEnvelope(resumed, 'm1'), idle(resumed)],
        [assistantEnvelope(fresh, 'm2'), textPart(fresh, 'm2', 'p1', 'ok'), idle(fresh)],
      ],
      [fresh],
    );

    const query = newProvider(deps).query({
      prompt: 'do the thing',
      continuation: resumed,
      cwd: '/workspace/agent',
      systemContext: { instructions: 'BE BRIEF' },
    });
    await drainUntilResult(query.events);

    const replayText = (prompts[1]!.parts[0] as { text: string }).text;
    // One <system> block, not the resume text wrapped a second time.
    expect(replayText.match(/<system>/g) ?? []).toHaveLength(1);
    expect(replayText).toContain('BE BRIEF');
    expect(replayText).toContain('do the thing');
    query.abort();
  });

  it('test_oc_resume_tool_only_turn_is_work: a turn that produced a tool part is not replayed', async () => {
    // The assistant said nothing but did something. Replaying would discard the
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
    query.abort();
  });

  it('test_oc_resume_errored_turn_is_work: a provider error on the assistant record is not replayed', async () => {
    // An errored turn marks a LIVE session whose request failed. Replaying it
    // would throw away the history and bury the error.
    const resumed = 'sess-live';
    const { deps, created } = makeRuntime(
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
    await drainUntilResult(query.events);
    expect(created).toEqual([]);
    query.abort();
  });

  it('test_oc_resume_fresh_session_not_replayed: an opening query with no continuation never falls back', async () => {
    const fresh = 'sess-new';
    const { deps, prompts, created } = makeRuntime(
      [[assistantEnvelope(fresh, 'm1'), idle(fresh)]],
      [fresh, 'sess-should-not-be-used'],
    );

    const query = newProvider(deps).query({ prompt: 'hello', cwd: '/workspace/agent' });
    await drainUntilResult(query.events);

    // Exactly one session created (the opening one) and one prompt sent.
    expect(created).toEqual([fresh]);
    expect(prompts).toHaveLength(1);
    query.abort();
  });
});
