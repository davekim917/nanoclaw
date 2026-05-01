import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetBackendForTest,
  callClassifier,
  parseBackendConfig,
  setBackendForTest,
  validateClassifierOutput,
  ClassifierParseError,
} from './classifier-client.js';

afterEach(() => {
  _resetBackendForTest();
  vi.unstubAllEnvs();
});

describe('parseBackendConfig', () => {
  it('returns default for undefined env', () => {
    expect(parseBackendConfig(undefined)).toEqual({
      provider: 'anthropic',
      model: 'haiku-4-5',
      effort: 'default',
    });
  });

  it('returns default for empty string', () => {
    expect(parseBackendConfig('')).toEqual({
      provider: 'anthropic',
      model: 'haiku-4-5',
      effort: 'default',
    });
  });

  it('parses anthropic:sonnet-4-6:high', () => {
    expect(parseBackendConfig('anthropic:sonnet-4-6:high')).toEqual({
      provider: 'anthropic',
      model: 'sonnet-4-6',
      effort: 'high',
    });
  });

  it('parses codex:gpt-5.5:medium', () => {
    expect(parseBackendConfig('codex:gpt-5.5:medium')).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
    });
  });

  it('throws on missing parts', () => {
    expect(() => parseBackendConfig('anthropic:haiku-4-5')).toThrow(/format must be/);
  });

  it('throws on extra parts', () => {
    expect(() => parseBackendConfig('anthropic:haiku-4-5:high:extra')).toThrow(/format must be/);
  });

  it('throws on unknown provider', () => {
    expect(() => parseBackendConfig('cohere:command-r:high')).toThrow(/unknown provider/);
  });

  it('throws on unknown effort', () => {
    expect(() => parseBackendConfig('anthropic:haiku-4-5:max')).toThrow(/unknown effort/);
  });

  it('throws on empty model', () => {
    expect(() => parseBackendConfig('anthropic::high')).toThrow(/model alias must be non-empty/);
  });

  it('trims whitespace from parts', () => {
    expect(parseBackendConfig(' anthropic : sonnet-4-6 : high ')).toEqual({
      provider: 'anthropic',
      model: 'sonnet-4-6',
      effort: 'high',
    });
  });
});

describe('callClassifier facade', () => {
  it('uses test-injected backend when set', async () => {
    const backendSpy = vi.fn().mockResolvedValue({ worth_storing: false, facts: [] });
    setBackendForTest(backendSpy);

    const result = await callClassifier('sys', 'user', { timeoutMs: 5000 });
    expect(result).toEqual({ worth_storing: false, facts: [] });
    expect(backendSpy).toHaveBeenCalledWith('sys', 'user', { timeoutMs: 5000 });
  });

  it('passes opts.signal through to backend', async () => {
    const backendSpy = vi.fn().mockResolvedValue({ worth_storing: false, facts: [] });
    setBackendForTest(backendSpy);

    const ctrl = new AbortController();
    await callClassifier('sys', 'user', { signal: ctrl.signal });
    expect(backendSpy.mock.calls[0][2]).toEqual({ signal: ctrl.signal });
  });

  it('reads MEMORY_CLASSIFIER_BACKEND env on first call when no test backend set', async () => {
    // Don't actually invoke a real backend — set an invalid env so loadBackend
    // throws, then assert the parse error surfaces. This proves the env is
    // read on first call (vs hardcoded default).
    setBackendForTest(null);
    vi.stubEnv('MEMORY_CLASSIFIER_BACKEND', 'invalid-format');

    await expect(callClassifier('sys', 'user')).rejects.toThrow(/format must be/);
  });
});

describe('validateClassifierOutput', () => {
  const valid = {
    worth_storing: true,
    facts: [
      {
        content: 'x',
        category: 'fact',
        importance: 3,
        entities: ['x'],
        source_role: 'user',
      },
    ],
  };

  it('accepts valid output', () => {
    expect(validateClassifierOutput(valid).worth_storing).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(() => validateClassifierOutput('hello')).toThrow(ClassifierParseError);
  });

  it('rejects non-boolean worth_storing', () => {
    expect(() => validateClassifierOutput({ ...valid, worth_storing: 1 })).toThrow(/worth_storing/);
  });

  it('rejects facts not an array', () => {
    expect(() => validateClassifierOutput({ ...valid, facts: 'nope' })).toThrow(/facts must be/);
  });

  it('rejects fact with invalid category', () => {
    const bad = { ...valid, facts: [{ ...valid.facts[0], category: 'bogus' }] };
    expect(() => validateClassifierOutput(bad)).toThrow(/category/);
  });

  it('rejects fact with invalid source_role', () => {
    const bad = { ...valid, facts: [{ ...valid.facts[0], source_role: 'bogus' }] };
    expect(() => validateClassifierOutput(bad)).toThrow(/source_role/);
  });

  it('rejects fact with non-string content', () => {
    const bad = { ...valid, facts: [{ ...valid.facts[0], content: 42 }] };
    expect(() => validateClassifierOutput(bad)).toThrow(/content/);
  });
});
