import path from 'path';

import { describe, it, expect } from 'vitest';

import { threadWorktreeDir, threadsBaseDir } from './session-manager.js';

describe('threadWorktreeDir', () => {
  it('uses <mg>:<thread>/worktrees when threadId is present (colons inside thread are slugged)', () => {
    const got = threadWorktreeDir('mg-abc', 'discord:123/456');
    expect(got).toBe(path.join(threadsBaseDir(), 'mg-abc:discord_123_456', 'worktrees'));
  });

  it('sanitizes path-unsafe characters in mg and thread ids', () => {
    // Slack thread ids include '.' which is fine. Forward slashes get
    // sanitized to underscore. Colons are preserved (they are the
    // separator between mg + thread in the key).
    const got = threadWorktreeDir('mg-1', '1234567890.123456');
    expect(got).toContain('mg-1:1234567890.123456/worktrees');
  });

  it('falls back to msg-<id> surrogate when threadId is null', () => {
    const got = threadWorktreeDir('mg-dm-channel', null, 'msg-abc-1234');
    expect(got).toBe(path.join(threadsBaseDir(), 'mg-dm-channel:msg-msg-abc-1234', 'worktrees'));
  });

  it('falls back to "none" when both threadId and originatingMessageId are null', () => {
    const got = threadWorktreeDir('mg-x', null);
    expect(got).toBe(path.join(threadsBaseDir(), 'mg-x:none', 'worktrees'));
  });

  it('strips dangerous characters via fsSlug', () => {
    const got = threadWorktreeDir('mg-with-spaces and slashes/', 'thread\\bad*chars?');
    // Spaces, slashes, backslashes, asterisks, question marks → underscore.
    expect(got).toContain('mg-with-spaces_and_slashes_:thread_bad_chars_/worktrees');
  });
});
