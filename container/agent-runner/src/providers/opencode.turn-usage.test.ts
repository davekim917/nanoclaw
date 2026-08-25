import { describe, expect, it } from 'bun:test';

import { sumOpenCodeTurnUsage, type OpenCodeAssistantUsage } from './opencode.js';

/**
 * Ground truth: one real OpenCode session's assistant messages, read out of
 * that session's own `opencode.db` (the container's XDG data dir). OpenCode's
 * `session` row for it records tokens_input=325,382 / tokens_output=7,477 /
 * tokens_cache_read=1,927,040 across 19 assistant messages — i.e. OpenCode
 * itself sums these per-message figures, which is what proves they are
 * per-response and not a running total. The first 14 messages are reproduced
 * here; note the non-monotonic output column, impossible for a cumulative
 * counter.
 */
const REAL_SESSION: OpenCodeAssistantUsage[] = (
  [
    [62497, 22, 0],
    [76198, 25, 2304],
    [7147, 70, 78464],
    [14113, 85, 85568],
    [2093, 50, 99648],
    [9656, 51, 101696],
    [2511, 70, 111296],
    [4765, 35, 113792],
    [1675, 1186, 118528],
    [127941, 78, 0],
    [1939, 90, 127936],
    [1017, 925, 129856],
    [1142, 2988, 130816],
    [497, 252, 131904],
  ] as const
).map(([input, output, read]) => ({
  providerID: 'opencode-go',
  modelID: 'kimi-k2.7',
  cost: 0,
  tokens: { input, output, cache: { read, write: 0 } },
}));

describe('sumOpenCodeTurnUsage', () => {
  it('sums every assistant message in the turn instead of reporting only the last', () => {
    const last = REAL_SESSION[REAL_SESSION.length - 1];
    const usage = sumOpenCodeTurnUsage(REAL_SESSION, last);

    expect(usage).toMatchObject({
      inputTokens: 313_191,
      outputTokens: 5_927,
      cacheReadTokens: 1_231_808,
      cacheWriteTokens: 0,
    });
    // The pre-fix behavior — the last message alone — and why it mattered:
    // 252 of 5,927 output tokens, a 23.5x undercount on this turn.
    expect(usage?.outputTokens).not.toBe(last.tokens?.output);
  });

  it('carries the LAST message`s model, not the first', () => {
    const usage = sumOpenCodeTurnUsage(
      [
        { providerID: 'opencode-go', modelID: 'kimi-k2.7', tokens: { input: 10, output: 1 } },
        { providerID: 'anthropic', modelID: 'claude-opus-5', tokens: { input: 20, output: 2 } },
      ],
      { providerID: 'anthropic', modelID: 'claude-opus-5', tokens: { input: 20, output: 2 } },
    );
    expect(usage).toMatchObject({ model: 'anthropic/claude-opus-5', inputTokens: 30, outputTokens: 3 });
  });

  it('falls back to the bare model id when the provider id is missing', () => {
    const usage = sumOpenCodeTurnUsage([{ modelID: 'kimi-k2.7', tokens: { output: 5 } }], { modelID: 'kimi-k2.7' });
    expect(usage?.model).toBe('kimi-k2.7');
  });

  it('sums cost across messages', () => {
    const usage = sumOpenCodeTurnUsage(
      [{ cost: 0.01, tokens: { output: 1 } }, { cost: 0.02, tokens: { output: 1 } }, { tokens: { output: 1 } }],
      undefined,
    );
    expect(usage?.costUsd).toBeCloseTo(0.03, 10);
    expect(usage?.model).toBeNull();
  });

  it('returns undefined for a turn with no assistant message (coverage gap, not a fabricated zero)', () => {
    expect(sumOpenCodeTurnUsage([], undefined)).toBeUndefined();
  });
});
