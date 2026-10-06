import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { _resetConfig, _setConfigForTest } from './config.js';
import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';
import { ProviderEventError, ringRateLimitQuota, runPollLoop } from './poll-loop.js';

const RESETS = ['2026-10-06T00:40:00.000Z', '2026-10-06T00:10:00.000Z', '2026-10-06T01:00:00.000Z'];

beforeEach(() => {
  initTestSessionDb();
  _setConfigForTest({ provider: 'claude', providerFallback: { provider: 'codex' } });
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', ?, 'pending', 'chan-1', 'discord', 'thread-1', ?)`,
    )
    .run(new Date().toISOString(), JSON.stringify({ sender: 'Operator', text: 'go' }));
});

afterEach(() => {
  _resetConfig();
  closeSessionDb();
});

type SlotOutcome = 'rate_limit' | 'other' | 'ok';

/** A credential ring where each slot answers with the scripted outcome, the way the Claude provider yields them. */
class RingProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private slot = 0;
  private rotations = 0;

  constructor(private readonly outcomes: SlotOutcome[]) {}

  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }
  isRetryable(err: unknown): boolean {
    return err instanceof ProviderEventError && err.classification === 'rate_limit';
  }
  rotateApiKey(): { rotated: boolean } {
    if (this.rotations >= this.outcomes.length - 1) return { rotated: false };
    this.rotations++;
    this.slot++;
    return { rotated: true };
  }

  query(_input: QueryInput): AgentQuery {
    const slot = this.slot;
    const outcome = this.outcomes[slot];
    const events = {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        if (outcome === 'rate_limit') {
          yield {
            type: 'error',
            message: `Rate limit [five_hour] (resets ${RESETS[slot]})`,
            retryable: false,
            classification: 'rate_limit',
            resetAt: RESETS[slot],
          };
          return;
        }
        if (outcome === 'other') {
          yield { type: 'error', message: 'Internal server error', retryable: false };
          return;
        }
        yield { type: 'init', continuation: 'mock-session-1' };
        yield { type: 'result', text: '<message to="discord-test">answered</message>' };
      },
    };
    return {
      resolvedModel: 'mock',
      resolvedEffort: undefined,
      push() {},
      end() {},
      events,
      abort() {},
    } as unknown as AgentQuery;
  }
}

function outRows(): Array<{ kind: string; content: string }> {
  return getUndeliveredMessages().map((m) => ({ kind: m.kind, content: m.content }));
}

function unavailableReports(): Array<Record<string, unknown>> {
  return outRows()
    .filter((r) => r.kind === 'system')
    .map((r) => JSON.parse(r.content) as Record<string, unknown>)
    .filter((c) => c.action === 'provider_unavailable');
}

async function runUntil(provider: AgentProvider, predicate: () => boolean): Promise<void> {
  const controller = new AbortController();
  const loop = Promise.race([
    runPollLoop({ provider, providerName: 'claude', cwd: '/tmp', signal: controller.signal }),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out; rows were ${JSON.stringify(outRows())}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  controller.abort();
  await loop.catch(() => {});
}

describe('a rate limit on every credential is the account quota wall', () => {
  it('reports quota with the earliest measured slot reset', async () => {
    await runUntil(new RingProvider(['rate_limit', 'rate_limit', 'rate_limit']), () => unavailableReports().length > 0);

    const [report] = unavailableReports();
    expect(report.classification).toBe('quota');
    expect(report.resetAt).toBe('2026-10-06T00:10:00.000Z');
  });

  it('stays a plain outage when a slot failed for another reason', async () => {
    await runUntil(new RingProvider(['rate_limit', 'other']), () => unavailableReports().length > 0);

    const [report] = unavailableReports();
    expect(report.classification).toBe('unavailable');
  });

  it('reports nothing when another credential answers', async () => {
    await runUntil(new RingProvider(['rate_limit', 'ok']), () => outRows().some((r) => r.content.includes('answered')));

    expect(unavailableReports()).toHaveLength(0);
  });
});

describe('ringRateLimitQuota', () => {
  const rejection = (resetAt: string | null): ProviderEventError =>
    new ProviderEventError({
      type: 'error',
      message: 'Rate limit',
      retryable: false,
      classification: 'rate_limit',
      resetAt,
    });

  it('is not a quota wall while the ring still has an untried credential', () => {
    expect(ringRateLimitQuota([rejection(RESETS[0])], false)).toEqual({ exhausted: false, resetAt: null });
  });

  it('gives no reset when any slot did not measure one', () => {
    expect(ringRateLimitQuota([rejection(RESETS[0]), rejection(null)], true)).toEqual({
      exhausted: true,
      resetAt: null,
    });
  });

  it('never counts a credits wall or an untyped failure as a rate-limit ring', () => {
    const credits = new ProviderEventError({
      type: 'error',
      message: 'Out of credits',
      retryable: false,
      classification: 'quota',
    });
    expect(ringRateLimitQuota([rejection(RESETS[0]), credits], true).exhausted).toBe(false);
    expect(ringRateLimitQuota([rejection(RESETS[0]), new Error('boom')], true).exhausted).toBe(false);
  });
});
