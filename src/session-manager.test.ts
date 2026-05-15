import path from 'path';

import { describe, it, expect } from 'vitest';

import { threadWorktreeDir, threadsBaseDir } from './session-manager.js';

describe('threadWorktreeDir', () => {
  it('uses thread_id directly as the key when present', () => {
    const got = threadWorktreeDir('slack:C0AJA89MN2E', 'slack:C0AJA89MN2E:1778800261.935259');
    expect(got).toBe(path.join(threadsBaseDir(), 'slack_C0AJA89MN2E_1778800261.935259', 'worktrees'));
  });

  it('produces NO colons in the path (Docker -v safety)', () => {
    // Docker's -v flag treats `:` as source:target:options separator.
    // A colon anywhere in the host path causes Docker to reject with exit 125.
    const got = threadWorktreeDir('slack:C0AJA89MN2E', 'slack:C0AJA89MN2E:1778800261.935259');
    expect(got).not.toContain(':');
  });

  it('two siblings on different channelTypes but same platform_id resolve to same path', () => {
    // This is the cross-bot share invariant: illie (slack-illysium) and
    // illie-codex (slack-illiecodex) both see the same Slack channel, so they
    // get the same platform_id and the same thread_id from chat-sdk-bridge.
    // The mg ids differ (one per channelType), but the worktree path must
    // match for shared collaboration.
    const tid = 'slack:C0AJA89MN2E:1778800261.935259';
    const fromIllie = threadWorktreeDir('slack:C0AJA89MN2E', tid);
    const fromCodex = threadWorktreeDir('slack:C0AJA89MN2E', tid);
    expect(fromIllie).toBe(fromCodex);
  });

  it('falls back to dm-<platform_id> when threadId is null', () => {
    const got = threadWorktreeDir('slack:D0AK1BR5J92', null);
    expect(got).toBe(path.join(threadsBaseDir(), 'dm-slack_D0AK1BR5J92', 'worktrees'));
  });

  it('two siblings in the same DM (different mgs, same platform_id) share path', () => {
    const a = threadWorktreeDir('slack:D0AK1BR5J92', null);
    const b = threadWorktreeDir('slack:D0AK1BR5J92', null);
    expect(a).toBe(b);
  });

  it('strips dangerous characters via fsSlug', () => {
    const got = threadWorktreeDir('slack:weird*chan?', 'slack:weird*chan?:thread\\bad');
    expect(got).not.toContain('*');
    expect(got).not.toContain('?');
    expect(got).not.toContain(':');
    expect(got).not.toContain('\\');
  });
});
