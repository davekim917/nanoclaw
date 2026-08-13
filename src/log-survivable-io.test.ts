import { describe, expect, it } from 'vitest';

import { isSurvivableIoError } from './log.js';

describe('isSurvivableIoError', () => {
  it('treats broken-peer write errors as survivable', () => {
    for (const code of ['EPIPE', 'ECONNRESET']) {
      const err = Object.assign(new Error(`write ${code}`), { code, syscall: 'write' });
      expect(isSurvivableIoError(err)).toBe(true);
    }
  });

  it('still kills the host on real bugs', () => {
    expect(isSurvivableIoError(new TypeError('x is not a function'))).toBe(false);
    expect(isSurvivableIoError(Object.assign(new Error('open ENOENT'), { code: 'ENOENT' }))).toBe(false);
    expect(isSurvivableIoError(undefined)).toBe(false);
    expect(isSurvivableIoError('EPIPE')).toBe(false);
  });
});
