import { afterEach, describe, expect, it } from 'bun:test';
import { ClaudeProvider } from './claude.js';

// Circular OAuth rotation (incident 2026-06-25): forward-only rotation could
// land on a spend-capped fallback and dead-end there for the container's life.
// The ring must cycle through every credential and wrap back to the primary,
// give up only after a full cycle, and reset that budget per turn.
describe('ClaudeProvider OAuth circular rotation', () => {
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  });

  const make = (env: Record<string, string>) => new ClaudeProvider({ env });

  it('cycles through every other credential, then gives up for the turn', () => {
    const p = make({
      CLAUDE_CODE_OAUTH_TOKEN: 'primary',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'two',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'three',
    });
    p.resetRotationCycle();
    expect(p.rotateApiKey()).toEqual({ rotated: true });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('two');
    expect(p.rotateApiKey()).toEqual({ rotated: true });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('three');
    // ring length 3 → budget is 2 rotations/cycle; the 3rd gives up.
    expect(p.rotateApiKey()).toEqual({ rotated: false });
  });

  it('wraps from the last slot back to the primary on a fresh cycle (sticky position)', () => {
    const p = make({
      CLAUDE_CODE_OAUTH_TOKEN: 'primary',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'two',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'three',
    });
    p.resetRotationCycle();
    p.rotateApiKey(); // → two
    p.rotateApiKey(); // → three (position is now sticky at index 2)
    p.resetRotationCycle(); // new turn: fresh budget, position stays at three
    expect(p.rotateApiKey()).toEqual({ rotated: true });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('primary'); // wrapped past the end
  });

  it('returns rotated:false when the pool has a single credential', () => {
    const p = make({ CLAUDE_CODE_OAUTH_TOKEN: 'solo' });
    p.resetRotationCycle();
    expect(p.rotateApiKey()).toEqual({ rotated: false });
  });

  it('dedupes identical token values so a doubled token is not a rotation target', () => {
    const p = make({
      CLAUDE_CODE_OAUTH_TOKEN: 'same',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'same',
    });
    p.resetRotationCycle();
    expect(p.rotateApiKey()).toEqual({ rotated: false });
  });

  it('does not rotate OAuth when an API key is the active auth path', () => {
    const p = make({
      ANTHROPIC_API_KEY: 'sk-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'primary',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'two',
    });
    p.resetRotationCycle();
    // usingOauth is false (API key present) → OAuth ring is not consulted;
    // with no ANTHROPIC_API_KEY_N fallbacks the API-key path reports exhausted.
    expect(p.rotateApiKey()).toEqual({ rotated: false });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(saved);
  });
});
