import { afterEach, describe, expect, it } from 'vitest';

import { scaledTimeout } from './test-timeout-scale.js';

const ENV_KEY = 'NANOCLAW_COVERAGE_TIMEOUT_MULTIPLIER';

describe('scaledTimeout', () => {
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('is a no-op when the multiplier env var is unset (a plain vitest run)', () => {
    delete process.env[ENV_KEY];
    expect(scaledTimeout(20000)).toBe(20000);
  });

  it('multiplies by the env var when set', () => {
    process.env[ENV_KEY] = '4';
    expect(scaledTimeout(20000)).toBe(80000);
  });

  it('ignores a non-numeric or non-positive multiplier and returns the input unscaled', () => {
    for (const bad of ['not-a-number', '0', '-1']) {
      process.env[ENV_KEY] = bad;
      expect(scaledTimeout(5000)).toBe(5000);
    }
  });
});
