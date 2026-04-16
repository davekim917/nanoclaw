import { beforeEach, describe, expect, it } from 'vitest';

import { _clearSecretsForTest, registerSecrets, scrubSecrets } from './secret-scrubber.js';

describe('secret-scrubber', () => {
  beforeEach(() => _clearSecretsForTest());

  it('returns text unchanged when nothing is registered', () => {
    expect(scrubSecrets('My API key is xoxb-secretvalue')).toBe('My API key is xoxb-secretvalue');
  });

  it('redacts a registered value', () => {
    registerSecrets({ ANTHROPIC_API_KEY: 'sk-ant-1234567890abcdef' });
    expect(scrubSecrets('Key: sk-ant-1234567890abcdef ok')).toBe('Key: [REDACTED] ok');
  });

  it('redacts multiple occurrences of the same value', () => {
    registerSecrets({ T: 'abcdefgh' });
    expect(scrubSecrets('abcdefgh-abcdefgh')).toBe('[REDACTED]-[REDACTED]');
  });

  it('redacts multiple distinct secrets independently', () => {
    registerSecrets({ A: 'aaaaaaaa', B: 'bbbbbbbb' });
    expect(scrubSecrets('one aaaaaaaa two bbbbbbbb three')).toBe('one [REDACTED] two [REDACTED] three');
  });

  it('ignores values shorter than the minimum length', () => {
    registerSecrets({ SHORT: 'abc' });
    expect(scrubSecrets('abc abc abc')).toBe('abc abc abc');
  });

  it('ignores empty values', () => {
    registerSecrets({ EMPTY: '' });
    expect(scrubSecrets('anything')).toBe('anything');
  });

  it('returns text unchanged when text is empty', () => {
    registerSecrets({ A: 'aaaaaaaa' });
    expect(scrubSecrets('')).toBe('');
  });
});
