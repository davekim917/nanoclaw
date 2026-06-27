import { describe, it, expect } from 'bun:test';

import { classifyCodexError } from './codex.js';

// classifyCodexError maps a terminal codex turn error to the ProviderEvent
// `classification` the poll-loop catch path keys on. 'idle_timeout' is the
// signal that routes the codex idle-watchdog stall to in-place retry instead
// of dead-ending the user (2026-06-27).
describe('classifyCodexError', () => {
  it('classifies the idle-watchdog stall as idle_timeout', () => {
    expect(classifyCodexError('Codex turn idle for 60000ms (no notifications)', null)).toBe(
      'idle_timeout',
    );
  });

  it('classifies structured quota/overload errorKinds (rotation-eligible)', () => {
    expect(classifyCodexError('whatever', 'UsageLimitExceeded')).toBe('quota');
    expect(classifyCodexError('whatever', 'ServerOverloaded')).toBe('overloaded');
  });

  it('a rotation-eligible errorKind short-circuits the message checks', () => {
    // Even if the message looks idle-ish, a structured quota error wins and
    // does NOT fall through to idle_timeout.
    expect(classifyCodexError('idle for a while', 'UsageLimitExceeded')).toBe('quota');
  });

  it('classifies the coarse system-error wedge', () => {
    expect(classifyCodexError('codex_system_error: thread status changed', null)).toBe(
      'system_error',
    );
  });

  it('returns undefined for an unclassified terminal error', () => {
    expect(classifyCodexError('Unauthorized: bad token', 'Unauthorized')).toBeUndefined();
    expect(classifyCodexError('some other failure', null)).toBeUndefined();
  });
});
