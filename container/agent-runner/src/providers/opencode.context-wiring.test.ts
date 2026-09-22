/**
 * Is OpenCode's context reading actually WIRED?
 *
 * context-occupancy.test.ts pins `openCodeContextOccupancy`'s arithmetic; this
 * drives the provider's real SSE loop with scripted `message.updated` frames
 * and asserts the store moved. Without it the helper could be exported,
 * unit-tested and never called, with every test still green while the line in
 * chat showed a stale figure or none at all.
 *
 * Harness mirrors opencode.empty-resume.test.ts: a scripted event stream and
 * an injected runtime, so nothing spawns `opencode serve`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { OpenCodeProvider, type OpenCodeRuntimeDeps, type OpenCodeRuntimeHandle } from './opencode.js';
import type { ProviderEvent } from './types.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { formatStatusSubtext, resetTurnStatus, setTurnSettings } from '../turn-status.js';

type Ev = { type: string; properties: Record<string, unknown> };

beforeEach(() => {
  initTestSessionDb();
  resetTurnStatus();
});

afterEach(() => {
  resetTurnStatus();
  closeSessionDb();
});

function makeRuntime(script: Ev[], sessionId: string) {
  async function* stream(): AsyncGenerator<Ev, void, void> {
    for (const ev of script) yield ev;
    // Park rather than finish: the provider reads a completed stream as failure.
    await new Promise(() => {});
  }

  const runtime: OpenCodeRuntimeHandle = {
    client: {
      session: {
        async create() {
          return { data: { id: sessionId } };
        },
        async promptAsync() {
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
  return { getRuntime: async () => runtime } as OpenCodeRuntimeDeps;
}

function assistantTokens(
  sessionID: string,
  id: string,
  tokens: { input: number; output: number; cache?: { read?: number; write?: number } },
): Ev {
  return {
    type: 'message.updated',
    properties: {
      info: { id, role: 'assistant', sessionID, providerID: 'opencode-go', modelID: 'kimi-k2.7', cost: 0, tokens },
    },
  };
}

function textPart(sessionID: string, messageID: string, id: string, text: string): Ev {
  return { type: 'message.part.updated', properties: { part: { id, type: 'text', messageID, sessionID, text } } };
}

function idle(sessionID: string): Ev {
  return { type: 'session.idle', properties: { sessionID } };
}

async function runTurn(script: Ev[], sessionId: string): Promise<void> {
  const provider = new OpenCodeProvider({}, makeRuntime(script, sessionId));
  provider.registerMemorySessionHook({ command: 'noop', matcher: undefined } as never);
  const query = provider.query({ prompt: 'hello', cwd: '/workspace/agent' });
  const seen: ProviderEvent[] = [];
  for await (const ev of query.events) {
    if (ev.type === 'activity') continue;
    seen.push(ev);
    if (ev.type === 'result') break;
  }
  query.abort();
}

describe('opencode context reading is wired into the SSE loop', () => {
  it('records occupancy off a real assistant frame', async () => {
    setTurnSettings('opencode-go/kimi-k2.7', 'high');
    const s = 'sess-1';

    await runTurn(
      [
        assistantTokens(s, 'm1', { input: 497, output: 252, cache: { read: 131_904, write: 0 } }),
        textPart(s, 'm1', 'p1', '<message to="here">done</message>'),
        idle(s),
      ],
      s,
    );

    expect(formatStatusSubtext()).toBe('kimi-k2.7 · high · 132k context');
  });

  it('tracks the LATEST frame across a multi-message turn', async () => {
    setTurnSettings('opencode-go/kimi-k2.7', 'medium');
    const s = 'sess-1';

    await runTurn(
      [
        assistantTokens(s, 'm1', { input: 2_093, output: 50, cache: { read: 99_648 } }),
        assistantTokens(s, 'm2', { input: 1_939, output: 90, cache: { read: 127_936 } }),
        textPart(s, 'm2', 'p1', '<message to="here">done</message>'),
        idle(s),
      ],
      s,
    );

    expect(formatStatusSubtext()).toBe('kimi-k2.7 · medium · 130k context');
  });

  it('ignores a subagent session — that is ITS window, not ours', async () => {
    // Subagent responses arrive under their OWN session id and are real spend,
    // so they belong in the usage SUM — but their prompt size says nothing
    // about this session's window. Counting one would make the parent's
    // context appear to collapse.
    setTurnSettings('opencode-go/kimi-k2.7', 'high');
    const s = 'sess-1';

    await runTurn(
      [
        assistantTokens(s, 'm1', { input: 1_939, output: 90, cache: { read: 127_936 } }),
        assistantTokens('sess-subagent', 'm2', { input: 300, output: 40, cache: { read: 1_200 } }),
        textPart(s, 'm1', 'p1', '<message to="here">done</message>'),
        idle(s),
      ],
      s,
    );

    expect(formatStatusSubtext()).toBe('kimi-k2.7 · high · 130k context');
  });

  it('leaves the line without a figure when no frame reported tokens', async () => {
    setTurnSettings('opencode-go/kimi-k2.7', 'low');
    const s = 'sess-1';

    await runTurn(
      [
        { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: s } } },
        textPart(s, 'm1', 'p1', '<message to="here">done</message>'),
        idle(s),
      ],
      s,
    );

    expect(formatStatusSubtext()).toBe('kimi-k2.7 · low');
  });
});
