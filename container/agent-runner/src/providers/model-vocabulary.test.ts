import { describe, expect, it } from 'bun:test';

import { modelBelongsToProvider } from './model-vocabulary.js';

describe('modelBelongsToProvider', () => {
  // One table, three providers: the partition must be exhaustive and
  // disjoint, or a pin could be dropped by every provider (or by none).
  const cases: Array<[model: string, claude: boolean, codex: boolean, opencode: boolean]> = [
    ['gpt-6-astra', false, true, false],
    ['gpt-5.5', false, true, false],
    ['claude-opus-5[1m]', true, false, false],
    ['claude-fable-5-1', true, false, false],
    ['opus', true, false, false],
    ['opencode-go/kimi-k2.7-code', false, false, true],
    ['nvidia/meta/llama-3.3-70b-instruct', false, false, true],
  ];
  for (const [model, claude, codex, opencode] of cases) {
    it(`${model} → claude=${claude} codex=${codex} opencode=${opencode}`, () => {
      expect(modelBelongsToProvider(model, 'claude')).toBe(claude);
      expect(modelBelongsToProvider(model, 'codex')).toBe(codex);
      expect(modelBelongsToProvider(model, 'opencode')).toBe(opencode);
    });
  }

  it('an unknown provider name takes the claude partition, like the host vocabulary lookup', () => {
    // src/flag-parser.ts `vocabFor`: unknown providers fall back to the Claude vocabulary.
    expect(modelBelongsToProvider('opus', 'mock')).toBe(true);
    expect(modelBelongsToProvider('gpt-6-astra', 'mock')).toBe(false);
  });
});
