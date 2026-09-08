import { describe, expect, it } from 'bun:test';

import { attachTurnEffort } from './turn-effort.js';
import type { TurnUsageInfo } from './types.js';

describe('attachTurnEffort', () => {
  it('stamps effective and requested effort on a single-entry turn', () => {
    const out = attachTurnEffort(
      { model: 'claude-opus-5[1m]', inputTokens: 10 },
      { model: 'claude-opus-5[1m]', effective: 'high', requested: 'high' },
    );
    expect(out).toEqual({ model: 'claude-opus-5[1m]', inputTokens: 10, effort: 'high', effortRequested: 'high' });
  });

  it('attaches to a single-entry turn even when the model id does not match', () => {
    // One entry IS the turn — there is no second model for the value to be
    // smeared onto, so withholding it here would under-report every codex and
    // opencode turn (their usage model string comes from the assistant
    // message, not from our own resolution).
    const out = attachTurnEffort(
      { model: 'opencode-go/glm-5.3-flash', inputTokens: 5 },
      { model: undefined, effective: 'high', requested: 'xhigh' },
    );
    expect(out).toMatchObject({ effort: 'high', effortRequested: 'xhigh' });
  });

  it('records a NULL effective effort alongside the requested one when the provider clamped it away', () => {
    const out = attachTurnEffort(
      { model: 'claude-haiku-4-5-20251001' },
      { model: 'claude-haiku-4-5-20251001', effective: undefined, requested: 'high' },
    );
    // Not "no effort was configured" — "high was configured and Haiku has no
    // effort control", which is a different finding.
    expect(out).toMatchObject({ effort: null, effortRequested: 'high' });
  });

  it('attributes a multi-model turn to the active model only, leaving subagent rows NULL', () => {
    const out = attachTurnEffort(
      [
        { model: 'claude-opus-5[1m]', inputTokens: 100 },
        { model: 'claude-sonnet-5', inputTokens: 50 },
        { model: 'claude-haiku-4-5-20251001', inputTokens: 5 },
      ],
      { model: 'claude-opus-5[1m]', effective: 'high', requested: 'high' },
    ) as TurnUsageInfo[];

    expect(out.map((u) => [u.model, u.effort])).toEqual([
      ['claude-opus-5[1m]', 'high'],
      ['claude-sonnet-5', null],
      ['claude-haiku-4-5-20251001', null],
    ]);
    // The lie this rule prevents: stamping the parent's `high` onto a Haiku
    // row, for a model that supports no effort at all.
    expect(out[2]!.effortRequested).toBeNull();
  });

  it('leaves every row of a multi-model turn NULL when the active model is unknown', () => {
    const out = attachTurnEffort(
      [{ model: 'a' }, { model: 'b' }],
      { model: null, effective: 'high', requested: 'high' },
    ) as TurnUsageInfo[];
    expect(out.every((u) => u.effort === null && u.effortRequested === null)).toBe(true);
  });

  it('never mutates the provider`s own usage objects', () => {
    const original: TurnUsageInfo = { model: 'claude-opus-5[1m]', inputTokens: 1 };
    attachTurnEffort(original, { model: 'claude-opus-5[1m]', effective: 'high', requested: 'high' });
    expect(original.effort).toBeUndefined();
  });

  it('passes an absent usage report through as undefined', () => {
    expect(attachTurnEffort(undefined, { model: 'm', effective: 'high', requested: 'high' })).toBeUndefined();
  });
});
