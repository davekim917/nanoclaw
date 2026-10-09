/**
 * The return from a provider fallback, driven through the real poll loop: the host restarts the session on its
 * primary with a `provider_fallback_return` wake, and only the primary answering that wake may tell the thread the
 * primary is back or end its failure streak.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { _resetConfig, _setConfigForTest } from './config.js';
import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import type { AgentProvider, AgentQuery, QueryInput } from './providers/types.js';
import { runPollLoop, STALE_SESSION_NOTICE } from './poll-loop.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { confirmProviderTurn, markProviderTurnUnconfirmed } from './provider-turn-completed.js';
import type { MessageInRow } from './db/messages-in.js';

const RETURN_WAKE = {
  text: '[system] This session ran on claude while codex was unavailable.',
  sender: 'system',
  senderId: 'system',
  _system: { kind: 'provider_fallback_return', provider: 'codex', from: 'claude' },
};

beforeEach(() => {
  initTestSessionDb();
  markProviderTurnUnconfirmed();
  _setConfigForTest({ provider: 'codex', providerFallback: { provider: 'claude' } });
  const db = getInboundDb();
  db.run(
    'CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY, channel_type TEXT, platform_id TEXT, thread_id TEXT)',
  );
  db.run("INSERT OR REPLACE INTO session_routing VALUES (1, 'slack', 'C1', 'T1')");
  // Shaped as the host's `writeSystemWake` writes it.
  db.prepare(
    `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content, on_wake)
     VALUES ('provider-return-1', 'chat', ?, 'pending', 'ag-1', 'agent', NULL, ?, 1)`,
  ).run(new Date().toISOString(), JSON.stringify(RETURN_WAKE));
});

afterEach(() => {
  _resetConfig();
  closeSessionDb();
});

class OneTurnProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  constructor(private readonly failure: Error | null) {}
  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }
  query(_input: QueryInput): AgentQuery {
    const failure = this.failure;
    const events = {
      async *[Symbol.asyncIterator]() {
        if (failure) throw failure;
        yield { type: 'init', continuation: 'codex-thread-2' } as const;
        yield { type: 'result', text: '' } as const;
      },
    };
    return { resolvedModel: 'gpt-test', resolvedEffort: null, push() {}, end() {}, events, abort() {} } as AgentQuery;
  }
}

/** A saved conversation that cannot be resumed, then a fresh one that answers. */
class StaleThenFreshProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly queries: Array<{ prompt: string; continuation?: string }> = [];
  registerMemorySessionHook(): void {}
  isSessionInvalid(err: unknown): boolean {
    return String(err).includes('thread/resume timed out');
  }
  query(input: QueryInput): AgentQuery {
    this.queries.push({ prompt: input.prompt, continuation: input.continuation });
    const resuming = input.continuation !== undefined;
    const events = {
      async *[Symbol.asyncIterator]() {
        if (resuming) throw new Error('thread/resume timed out for saved thread stuck-thread');
        yield { type: 'init', continuation: 'fresh-thread' } as const;
        yield { type: 'result', text: '' } as const;
      },
    };
    return { resolvedModel: 'gpt-test', resolvedEffort: null, push() {}, end() {}, events, abort() {} } as AgentQuery;
  }
}

function outRows(): Array<{ kind: string; thread_id: string | null; content: Record<string, unknown> }> {
  return getUndeliveredMessages().map((m) => ({
    kind: m.kind,
    thread_id: m.thread_id,
    content: JSON.parse(m.content) as Record<string, unknown>,
  }));
}

const actions = (): unknown[] => outRows().map((r) => r.content.action);
const chatTexts = (): string[] =>
  outRows()
    .filter((r) => r.kind === 'chat')
    .map((r) => String(r.content.text));

async function runUntil(provider: AgentProvider, done: () => boolean): Promise<void> {
  const controller = new AbortController();
  const loop = runPollLoop({ provider, providerName: 'codex', cwd: '/tmp', signal: controller.signal });
  const deadline = Date.now() + 8_000;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  // Lets anything the turn writes after the awaited row land before the assertions.
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await Promise.race([loop, new Promise((r) => setTimeout(r, 2_000))]);
  if (!done()) throw new Error(`turn never finished; rows were ${JSON.stringify(outRows())}`);
}

describe('returning from a provider fallback', () => {
  it('tells the thread and ends the streak once the primary answers the return wake', async () => {
    await runUntil(new OneTurnProvider(null), () => actions().includes('provider_turn_completed'));

    expect(chatTexts()).toEqual(['⚙️ codex is available again — this thread has moved back from claude.']);
    expect(outRows().find((r) => r.kind === 'chat')?.thread_id).toBe('T1');
    const report = outRows().find((r) => r.content.action === 'provider_turn_completed')!.content;
    expect(report.provider).toBe('codex');
    expect(Number.isFinite(Date.parse(String(report.completedAt)))).toBe(true);
  });

  it('says nothing and clears nothing when the primary fails the return wake', async () => {
    await runUntil(new OneTurnProvider(new Error('Timeout waiting for turn/start response (60000ms)')), () =>
      actions().includes('provider_unavailable'),
    );

    expect(actions()).not.toContain('provider_turn_completed');
    expect(chatTexts().filter((t) => t.includes('available again'))).toEqual([]);
  });
});

describe('confirmProviderTurn', () => {
  const wake = [{ content: JSON.stringify(RETURN_WAKE) }] as MessageInRow[];
  const noop = (): void => {};

  it('reports once per container until an outage re-arms it', async () => {
    await confirmProviderTurn([], { providerName: 'codex', onFallback: false }, noop);
    await confirmProviderTurn([], { providerName: 'codex', onFallback: false }, noop);
    expect(actions().filter((a) => a === 'provider_turn_completed')).toHaveLength(1);

    markProviderTurnUnconfirmed();
    await confirmProviderTurn([], { providerName: 'codex', onFallback: false }, noop);
    expect(actions().filter((a) => a === 'provider_turn_completed')).toHaveLength(2);
  });

  it('posts no return line from a container still on the fallback', async () => {
    await confirmProviderTurn(wake, { providerName: 'claude', onFallback: true }, noop);
    expect(chatTexts()).toEqual([]);
    expect(actions()).toEqual(['provider_turn_completed']);
  });

  it('reports nothing for a group with no declared fallback', async () => {
    _setConfigForTest({ provider: 'codex' });
    await confirmProviderTurn(wake, { providerName: 'codex', onFallback: false }, noop);
    expect(outRows()).toEqual([]);
  });
});

describe('a saved conversation that will not resume', () => {
  it('is answered on a fresh one that is told its memory was reset, with no outage reported', async () => {
    setContinuation('codex', 'stuck-thread');
    const provider = new StaleThenFreshProvider();

    await runUntil(provider, () => actions().includes('provider_turn_completed'));

    expect(provider.queries.map((q) => q.continuation)).toEqual(['stuck-thread', undefined]);
    expect(provider.queries[1].prompt).toContain(STALE_SESSION_NOTICE.trim());
    expect(actions()).not.toContain('provider_unavailable');
    expect(getContinuation('codex')).toBe('fresh-thread');
  });
});
