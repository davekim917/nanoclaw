/**
 * How each provider derives the context figure in the status subtext.
 *
 * This is the riskiest arithmetic in the feature and it fails SILENTLY: every
 * wrong reading is still a plausible-looking number in a small gray line that
 * nobody double-checks. The two ways to get it wrong are opposites, which is
 * why no shared helper can do this job:
 *
 *   - Anthropic and OpenCode report DISJOINT prompt counters. Occupancy is the
 *     sum; reading `input` alone renders a nearly full window as almost empty.
 *   - Codex reports cached input as a SUBSET of input. Summing them
 *     double-counts the cached prefix, which on a warm thread is most of it.
 *
 * Swap the two conventions and each provider still produces a number — just a
 * badly wrong one. These cases pin the direction, per provider, with figures
 * taken from real sessions.
 */
import { describe, expect, it, beforeEach } from 'bun:test';

import { claudeContextOccupancy } from './claude.js';
import { openCodeContextOccupancy } from './opencode.js';
import { formatStatusSubtext, recordContextTokens, resetTurnStatus } from '../turn-status.js';

beforeEach(() => resetTurnStatus());

describe('Claude — disjoint prompt counters', () => {
  it('sums all three, because input_tokens is only the UNCACHED remainder', () => {
    // A warm Opus thread: almost the whole prompt is a cache hit.
    const usage = { input_tokens: 1_507, cache_read_input_tokens: 142_912, cache_creation_input_tokens: 2_048 };

    expect(claudeContextOccupancy(usage)).toBe(146_467);
    // The failure this prevents: `input_tokens` alone is 1,507 — a full
    // window rendering as "1.5k context".
    expect(claudeContextOccupancy(usage)).toBeGreaterThan(usage.input_tokens * 90);
  });

  it('treats a null cache counter as nothing cached, not as a missing term', () => {
    // The SDK types these nullable. A null must not shrink the total.
    expect(
      claudeContextOccupancy({ input_tokens: 40_000, cache_read_input_tokens: null, cache_creation_input_tokens: null }),
    ).toBe(40_000);
  });

  it('answers 0 for an absent or empty usage report', () => {
    expect(claudeContextOccupancy(undefined)).toBe(0);
    expect(claudeContextOccupancy(null)).toBe(0);
    expect(claudeContextOccupancy({})).toBe(0);
  });

  it('a 0 leaves the previous reading standing rather than zeroing the display', () => {
    recordContextTokens(claudeContextOccupancy({ input_tokens: 500, cache_read_input_tokens: 141_900 }));
    recordContextTokens(claudeContextOccupancy(undefined));
    expect(formatStatusSubtext()).toBe('142k context');
  });
});

describe('OpenCode — disjoint, like Anthropic', () => {
  it('sums input, cache read and cache write', () => {
    // Last assistant message of the real session recorded in
    // sumOpenCodeTurnUsage's header.
    expect(openCodeContextOccupancy({ input: 497, output: 252, cache: { read: 131_904, write: 0 } })).toBe(132_401);
  });

  it('does NOT treat cache.read as a subset of input', () => {
    // The whole-session evidence: input summed to 325,382 while cache.read
    // summed to 1,927,040 — impossible if read were contained in input. So
    // the sum is right here and would be a double-count under Codex's rules.
    const occupancy = openCodeContextOccupancy({ input: 1_939, cache: { read: 127_936 } });
    expect(occupancy).toBe(129_875);
    expect(occupancy).not.toBe(1_939);
  });

  it('answers 0 for a message with no token report', () => {
    expect(openCodeContextOccupancy(undefined)).toBe(0);
    expect(openCodeContextOccupancy({})).toBe(0);
  });
});

describe('Codex — cached input is a SUBSET of input', () => {
  /**
   * Codex's own answer, not ours: `TokenUsage::tokens_in_context_window()`
   * returns `total_tokens` (codex-rs/protocol/src/protocol.rs), and the same
   * file defines `non_cached_input() = input_tokens - cached_input()` — which
   * is only meaningful if cached is contained in input.
   *
   * providers/codex.ts records `last.totalTokens` directly, so what is pinned
   * here is the CHOICE: totalTokens, not the Anthropic-style sum, and not the
   * thread-scoped running counter. Figures are from the real rollout already
   * used in codex.token-usage.test.ts.
   */
  const last = { totalTokens: 136_466, inputTokens: 129_606, cachedInputTokens: 126_720, outputTokens: 6_860 };

  it('uses totalTokens, which is Codex`s own tokens_in_context_window()', () => {
    recordContextTokens(last.totalTokens);
    expect(formatStatusSubtext()).toBe('136k context');
  });

  it('the Anthropic-style sum would double-count the cached prefix here', () => {
    // Documents the trap rather than the code: input + cached is 256,326 for a
    // window actually holding 136,466 — nearly double, and still a plausible
    // number.
    const wrong = last.inputTokens + last.cachedInputTokens;
    expect(wrong).toBeGreaterThan(last.totalTokens * 1.8);
  });

  it('never the thread-scoped running counter', () => {
    // `total` survives container respawns and measures the THREAD; on the
    // first turn after a respawn it was 8.3M in the recorded rollout while the
    // window held a few thousand tokens.
    const threadTotal = 8_378_126;
    expect(threadTotal).toBeGreaterThan(last.totalTokens * 50);
  });
});
