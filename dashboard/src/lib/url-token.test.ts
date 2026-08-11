import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { takeUrlToken } from './url-token.js';

function setUrl(pathname: string, search: string, hash: string): void {
  vi.stubGlobal('location', { pathname, search, hash });
}

describe('takeUrlToken', () => {
  let replaceState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the token from the fragment and scrubs the URL', () => {
    setUrl('/dashboard/', '', '#token=abc123');
    expect(takeUrlToken()).toBe('abc123');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/dashboard/');
  });

  it('accepts a hand-built query token and scrubs it too', () => {
    setUrl('/dashboard/', '?token=abc123', '');
    expect(takeUrlToken()).toBe('abc123');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/dashboard/');
  });

  it('leaves an ordinary route hash alone', () => {
    setUrl('/dashboard/', '', '#/workgroup');
    expect(takeUrlToken()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('returns null with no token anywhere', () => {
    setUrl('/dashboard/', '', '');
    expect(takeUrlToken()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('ignores a fragment that only looks like a token param', () => {
    // Guards the anchored regex: a token must be the WHOLE fragment, so a
    // route carrying a lookalike suffix is never treated as credentials.
    setUrl('/dashboard/', '', '#/session/abc?token=nope');
    expect(takeUrlToken()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
