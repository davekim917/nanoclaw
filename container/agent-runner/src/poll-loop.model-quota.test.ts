/**
 * The model-drop rung, driven through the real poll loop.
 *
 * `poll-loop.test.ts` covers the DECISION and the chat line this recovery
 * produces. This file covers the part those cannot reach: that the retry is
 * actually wired — that it re-queries with the pin REMOVED, that the turn is
 * marked recovered so no `provider_unavailable` is reported, and that the
 * session is left in a state that does not pay the recovery again next turn.
 *
 * Worth a real loop rather than a unit test because the failure mode is
 * silent. `processQuery` takes fifteen positional arguments, several of them
 * `string | undefined` in a row, so a mis-ordered copy of the neighbouring
 * credential-rotation retry typechecks cleanly and only misbehaves at
 * runtime — which is exactly what the pinned-model recovery would look like
 * if it were subtly wrong: a turn that still reaches the fallback.
 *
 * Measured 2026-09-21 22:35Z: a pinned `claude-fable-5-1[1m]` was rejected on
 * every OAuth slot and the group was rerouted to its codex fallback, while
 * sibling sessions of the same group kept completing turns on the group's own
 * model. That is the shape reproduced here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getStickyModel } from './modules/mailbox/session-state.js';
import type { AgentProvider, AgentQuery, QueryInput } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

const PIN = 'claude-fable-5-1[1m]';

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

/**
 * A provider whose PINNED tier is spent and whose own default still answers —
 * the asymmetry the whole rung exists for. Every credential looks the same to
 * it, so it also stands in for a ring that has been exhausted on that model.
 */
class PinnedTierExhaustedProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  /** Every `input.model` the loop asked for, in order. */
  readonly modelsAsked: Array<string | undefined> = [];

  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }
  // The rung is gated on the provider's own quota verdict, so the stub has to
  // give one; `isRetryable` stays absent so no credential rotation runs first
  // and the test observes the model drop alone.
  isQuotaExhausted(): boolean {
    return true;
  }

  query(input: QueryInput): AgentQuery {
    this.modelsAsked.push(input.model);
    const pinned = input.model;
    // Deliberately NOT MockProvider for the success branch: its stream stays
    // open until push()/end(), so the retry's `processQuery` would not return
    // until the test aborted the loop — and everything this file asserts
    // happens AFTER that return. A one-shot stream ends on its own, which is
    // what a real completed turn does.
    const events = {
      async *[Symbol.asyncIterator]() {
        if (pinned !== undefined) throw new Error(`Rate limit [seven_day_overage_included] for ${pinned}`);
        yield { type: 'init', continuation: 'mock-session-1' } as const;
        yield { type: 'result', text: '<message to="discord-test">answered</message>' } as const;
      },
    };
    return { resolvedModel: pinned ?? 'mock:group-default', push() {}, end() {}, events, abort() {} } as AgentQuery;
  }
}

function insertPinnedMessage(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', 'thread-1', ?)`,
    )
    .run(JSON.stringify({ sender: 'Operator', text: 'go', flagIntent: { stickyModel: PIN } }));
}

function outRows(): Array<{ kind: string; content: string }> {
  return getUndeliveredMessages().map((m) => ({ kind: m.kind, content: m.content }));
}

function action(row: { kind: string; content: string }): string | undefined {
  if (row.kind !== 'system') return undefined;
  return (JSON.parse(row.content) as { action?: string }).action;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out; rows were ${JSON.stringify(outRows())}`);
}

/**
 * `runPollLoop` does not settle on abort alone, so every caller here races it
 * — same shape as integration.test.ts. Without the race the test hangs on the
 * loop rather than on the condition it is actually asserting, which reads as a
 * failure of the feature instead of a failure of the harness.
 */
function startLoop(provider: AgentProvider, signal: AbortSignal): Promise<unknown> {
  return Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal }),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
}

/** The recovery's own chat line — the LAST thing the turn writes, so waiting
 *  on it is what makes the assertions below see a finished turn. */
function quotaNotices(): string[] {
  return outRows()
    .filter((r) => r.kind === 'chat')
    .map((r) => (JSON.parse(r.content) as { text: string }).text)
    .filter((t) => t.includes('is out of quota'));
}

describe('a spent model tier does not spend the provider', () => {
  it('re-asks with the pin removed, answers the turn, and reports no outage', async () => {
    insertPinnedMessage();
    const provider = new PinnedTierExhaustedProvider();
    const controller = new AbortController();
    const loop = startLoop(provider, controller.signal);

    await waitFor(() => quotaNotices().length > 0, 8000);
    controller.abort();
    await loop.catch(() => {});

    // The pinned attempt, then exactly one retry carrying NO model — which is
    // how each provider is told to resolve its own configured default
    // (claude.ts:2739, codex.ts:451 via resolveQueryModel, opencode.ts:1286).
    expect(provider.modelsAsked).toEqual([PIN, undefined]);

    // The user got a real answer, not an error and not silence.
    expect(outRows().some((r) => r.content.includes('answered'))).toBe(true);

    // And the host was never told the provider was unusable — the whole point.
    expect(outRows().map(action)).not.toContain('provider_unavailable');
  });

  it('clears the sticky pin so the next turn does not pay the recovery again', async () => {
    insertPinnedMessage();
    const provider = new PinnedTierExhaustedProvider();
    const controller = new AbortController();
    const loop = startLoop(provider, controller.signal);

    await waitFor(() => quotaNotices().length > 0, 8000);
    controller.abort();
    await loop.catch(() => {});

    expect(getStickyModel()).toBeUndefined();
    // …and the user is told, because a different model answered them and
    // nothing else in the transcript would say so.
    expect(quotaNotices()[0]).toContain(`${PIN} is out of quota`);
    expect(quotaNotices()[0]).toContain('re-pin with');
  });
});
