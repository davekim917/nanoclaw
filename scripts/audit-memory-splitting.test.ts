import { describe, expect, it } from 'vitest';

import { groupCoCapturedFacts } from './audit-memory-splitting.js';

// P0-AC5 — the field-order regression guard. The audit's MARKER regex requires
// captured= immediately after evidence=, which is why the reason field lives
// BETWEEN id and evidence. If anyone moves it, this parses zero groups.
describe('audit-memory-splitting marker compatibility', () => {
  const legacy = (n: number, ev: string, at: string) =>
    `- Legacy fact ${n}. <!-- nanoclaw-memory:id=mem_${String(n).repeat(16).slice(0, 16)};evidence=${ev};captured=${at} -->`;
  const reasoned = (n: number, ev: string, at: string) =>
    `- Reasoned fact ${n}. <!-- nanoclaw-memory:id=mem_${String(n).repeat(16).slice(0, 16)};reason=domain_knowledge;evidence=${ev};captured=${at} -->`;

  it('groups reason-bearing markers exactly like legacy ones', () => {
    const at = '2026-08-15T00:00:00.000Z';
    const content = [
      '# Generated workgroup memory',
      '',
      legacy(1, 'ev-a,ev-b', at),
      legacy(2, 'ev-a,ev-b', at),
      reasoned(3, 'ev-c,ev-d', at),
      reasoned(4, 'ev-c,ev-d', at),
      reasoned(5, 'ev-solo', at),
      '',
    ].join('\n');
    const groups = groupCoCapturedFacts(content, 'wg-test');
    // All five facts parse (a reason-bearing marker must not be skipped) ...
    expect(groups.reduce((sum, group) => sum + group.facts.length, 0)).toBe(5);
    // ... and the two co-captured pairs — one legacy, one reason-bearing —
    // group identically; the singleton stays alone.
    expect(groups.map((group) => group.facts.length).sort()).toEqual([1, 2, 2]);
    const reasonedPair = groups.find((group) => group.evidence === 'ev-c,ev-d');
    expect(reasonedPair?.capturedAt).toBe('2026-08-15T00:00:00.000Z');
  });
});
