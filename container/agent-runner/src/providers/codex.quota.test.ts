import { describe, expect, it } from 'bun:test';

import { CodexProvider, parkedTurnEvents } from './codex.js';

// The real thrown message, captured from a live app-server on a spent
// account. The reset date and billing URL vary per account, so the matcher
// must key on the stable phrasing rather than the whole sentence.
const REAL_MESSAGE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 12:42 AM.";

describe('CodexProvider.isQuotaExhausted', () => {
  const provider = Object.create(CodexProvider.prototype) as CodexProvider;

  it('matches the query-path usage-limit error the CLI actually throws', () => {
    expect(provider.isQuotaExhausted(new Error(REAL_MESSAGE))).toBe(true);
  });

  it('matches a non-Error rejection carrying the same text', () => {
    expect(provider.isQuotaExhausted(REAL_MESSAGE)).toBe(true);
  });

  it('does not treat a stale thread or ordinary failure as a spent account', () => {
    expect(provider.isQuotaExhausted(new Error('thread not found'))).toBe(false);
    expect(provider.isQuotaExhausted(new Error('Turn failed'))).toBe(false);
    expect(provider.isQuotaExhausted(new Error('stream disconnected'))).toBe(false);
  });

  it('does not fire on a transient server overload — that is recoverable in-turn', () => {
    expect(provider.isQuotaExhausted(new Error('ServerOverloaded: try again shortly'))).toBe(false);
  });

  it('treats an error event already classified quota as a spent account, whatever its wording', () => {
    // The poll-loop hands over its ProviderEventError, which carries the
    // classification; the pre-turn rate-limit park is worded nothing like the
    // CLI's usage-limit sentence and must still route to the fallback.
    const parked = Object.assign(new Error('Codex rate limit [seven_day] 92% used'), { classification: 'quota' });
    expect(provider.isQuotaExhausted(parked)).toBe(true);
    const other = Object.assign(new Error('Codex rate limit [seven_day] 92% used'), { classification: 'system_error' });
    expect(provider.isQuotaExhausted(other)).toBe(false);
  });
});

describe('parkedTurnEvents', () => {
  it('replaces the turn with one non-retryable quota error carrying the measured reset', async () => {
    const events = [];
    for await (const ev of parkedTurnEvents({
      reason: 'seven_day_threshold',
      reachedType: null,
      limitType: 'seven_day',
      usedPercent: 92,
      resetsAt: '2026-09-17T00:00:00.000Z',
      message: 'Codex rate limit [seven_day] 92% used',
    })) {
      events.push(ev);
    }
    expect(events).toEqual([
      {
        type: 'error',
        message: 'Codex rate limit [seven_day] 92% used',
        retryable: false,
        classification: 'quota',
        resetAt: '2026-09-17T00:00:00.000Z',
      },
    ]);
  });
});
