import { describe, it, expect } from 'bun:test';

import { classifyCodexError } from './codex.js';

// classifyCodexError maps a terminal codex turn error to the ProviderEvent
// `classification` the provider recovery and poll-loop catch paths key on.
describe('classifyCodexError', () => {
  it('classifies the idle-watchdog stall as idle_timeout', () => {
    expect(classifyCodexError('Codex turn idle for 60000ms (no notifications)', null)).toBe('idle_timeout');
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
    expect(classifyCodexError('codex_system_error: thread status changed', null)).toBe('system_error');
  });

  it('classifies control-plane health failures for provider-local recovery', () => {
    expect(classifyCodexError('codex_control_plane_unresponsive: three probes timed out', null)).toBe(
      'control_plane_unresponsive',
    );
    expect(classifyCodexError('codex_protocol_desync: root was idle', null)).toBe('protocol_desync');
  });

  it('returns undefined for an unclassified terminal error', () => {
    expect(classifyCodexError('Unauthorized: bad token', 'Unauthorized')).toBeUndefined();
    expect(classifyCodexError('some other failure', null)).toBeUndefined();
  });
});
