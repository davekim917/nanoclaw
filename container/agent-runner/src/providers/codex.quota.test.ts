import { describe, expect, it } from 'bun:test';

import { CodexProvider } from './codex.js';

// The real thrown message, captured from a live app-server on a spent
// account. The reset date and billing URL vary per account, so the matcher
// must key on the stable phrasing rather than the whole sentence.
const REAL_MESSAGE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 12:42 AM.";

describe('CodexProvider.isQuotaExhausted', () => {
  const provider = Object.create(CodexProvider.prototype) as CodexProvider;

  it('matches the query-path usage-limit error the CLI actually throws', () => {
    expect(provider.isQuotaExhausted(new Error(REAL_MESSAGE))).toBe(true);
  });

  it('matches a non-Error rejection carrying the same text', () => {
    expect(provider.isQuotaExhausted(REAL_MESSAGE)).toBe(true);
  });

  it('does not treat a stale thread or ordinary failure as a spent account', () => {
    expect(provider.isQuotaExhausted(new Error('thread not found'))).toBe(false);
    expect(provider.isQuotaExhausted(new Error('Turn failed'))).toBe(false);
    expect(provider.isQuotaExhausted(new Error('stream disconnected'))).toBe(false);
  });

  it('does not fire on a transient server overload — that is recoverable in-turn', () => {
    expect(provider.isQuotaExhausted(new Error('ServerOverloaded: try again shortly'))).toBe(false);
  });
});
