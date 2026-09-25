import { describe, expect, it } from 'bun:test';

import {
  isCodexFamilyName,
  modelBelongsToProvider,
  resolveCodexFamily,
  resolveFamilyModel,
} from './model-vocabulary.js';

describe('modelBelongsToProvider', () => {
  // One table, three providers: the partition must be exhaustive and
  // disjoint, or a pin could be dropped by every provider (or by none).
  const cases: Array<[model: string, claude: boolean, codex: boolean, opencode: boolean]> = [
    ['gpt-6-astra', false, true, false],
    ['gpt-5.5', false, true, false],
    ['claude-opus-5[1m]', true, false, false],
    ['claude-fable-5-1', true, false, false],
    ['opus', true, false, false],
    ['fable', true, false, false],
    ['sol', false, true, false],
    ['astra', false, true, false],
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

describe('resolveCodexFamily', () => {
  const env = { NANOCLAW_CODEX_MODEL_ALIASES: JSON.stringify({ sol: 'gpt-6-sol', astra: 'gpt-6-astra' }) };

  it('resolves a family name through the host-sent map, case-insensitively', () => {
    expect(resolveCodexFamily('sol', env)).toBe('gpt-6-sol');
    expect(resolveCodexFamily('ASTRA', env)).toBe('gpt-6-astra');
  });

  it('leaves concrete ids and non-family words alone', () => {
    expect(resolveCodexFamily('gpt-5.6-sol', env)).toBe('gpt-5.6-sol');
    expect(resolveCodexFamily('opus', env)).toBe('opus');
  });

  it('leaves a family name unresolved when the map is missing, malformed, or maps to a non-gpt value', () => {
    expect(resolveCodexFamily('sol', {})).toBe('sol');
    expect(resolveCodexFamily('sol', { NANOCLAW_CODEX_MODEL_ALIASES: '{not json' })).toBe('sol');
    expect(resolveCodexFamily('sol', { NANOCLAW_CODEX_MODEL_ALIASES: '{"sol":"opus"}' })).toBe('sol');
    expect(isCodexFamilyName('sol')).toBe(true);
    expect(isCodexFamilyName('constructor')).toBe(false);
  });
});

describe('resolveFamilyModel', () => {
  const env = {
    NANOCLAW_CODEX_MODEL_ALIASES: JSON.stringify({ sol: 'gpt-6-sol' }),
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1[1m]',
  };

  it('resolves a family word of either provider, case-insensitively', () => {
    expect(resolveFamilyModel('SOL', env)).toBe('gpt-6-sol');
    expect(resolveFamilyModel('Fable', env)).toBe('claude-fable-5-1[1m]');
  });

  it('leaves concrete ids, unknown words and prototype keys alone', () => {
    expect(resolveFamilyModel('gpt-6-astra', env)).toBe('gpt-6-astra');
    expect(resolveFamilyModel('constructor', env)).toBe('constructor');
    expect(resolveFamilyModel('opus', env)).toBe('opus'); // no env answer: unchanged
  });
});
