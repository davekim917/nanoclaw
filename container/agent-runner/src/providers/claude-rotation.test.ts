import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ClaudeProvider } from './claude.js';
import { getCredentialSlot, setCredentialSlot } from '../modules/mailbox/session-state.js';
import { initTestSessionDb } from '../modules/mailbox/testing.js';

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
    expect(p.rotateApiKey()).toEqual({
      rotated: true,
      slot: 'CLAUDE_CODE_OAUTH_TOKEN_2',
      position: 2,
      ringSize: 3,
    });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('two');
    expect(p.rotateApiKey()).toEqual({
      rotated: true,
      slot: 'CLAUDE_CODE_OAUTH_TOKEN_3',
      position: 3,
      ringSize: 3,
    });
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
    expect(p.rotateApiKey()).toEqual({
      rotated: true,
      slot: 'CLAUDE_CODE_OAUTH_TOKEN',
      position: 1,
      ringSize: 3,
    });
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

describe('ClaudeProvider ANTHROPIC_API_KEY fallback rotation reports slot/position/ringSize', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('reports the fallback name, 1-based position (primary=1), and total ring size', () => {
    const p = new ClaudeProvider({
      env: {
        ANTHROPIC_API_KEY: 'primary-key',
        ANTHROPIC_API_KEY_2: 'fallback-two',
        ANTHROPIC_API_KEY_3: 'fallback-three',
      },
    });
    expect(p.rotateApiKey()).toEqual({
      rotated: true,
      slot: 'ANTHROPIC_API_KEY_2',
      position: 2,
      ringSize: 3,
    });
    expect(process.env.ANTHROPIC_API_KEY).toBe('fallback-two');
    expect(p.rotateApiKey()).toEqual({
      rotated: true,
      slot: 'ANTHROPIC_API_KEY_3',
      position: 3,
      ringSize: 3,
    });
    // Forward-only: no more fallbacks left.
    expect(p.rotateApiKey()).toEqual({ rotated: false });
  });
});

// Deliverable C: the active ring/fallback slot survives a container respawn
// by round-tripping through session_state, so a fresh container doesn't burn
// a rejected turn on the primary before replaying its way back to the
// credential that was already known-healthy.
describe('ClaudeProvider credential slot persists across a simulated respawn', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  afterEach(() => {
    if (savedOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
  });

  const oauthEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: 'primary',
    CLAUDE_CODE_OAUTH_TOKEN_2: 'two',
    CLAUDE_CODE_OAUTH_TOKEN_3: 'three',
  };

  it('a rotation persists the slot name, and a fresh instance restores onto it', () => {
    const first = new ClaudeProvider({ env: oauthEnv });
    first.resetRotationCycle();
    first.rotateApiKey(); // → two
    first.rotateApiKey(); // → three
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN_3');

    // Simulate a respawn: a brand-new instance, same env, reads the
    // persisted slot in its constructor instead of starting at the primary.
    const second = new ClaudeProvider({ env: oauthEnv });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('three');
    // The restored ring position is what the next rotation advances from —
    // wrapping past "three" lands back on the primary, exactly as it would
    // have on the ORIGINAL instance had it kept running.
    second.resetRotationCycle();
    expect(second.rotateApiKey()).toEqual({
      rotated: true,
      slot: 'CLAUDE_CODE_OAUTH_TOKEN',
      position: 1,
      ringSize: 3,
    });
  });

  it('an unknown persisted slot (env changed since it was written) is ignored, staying on the primary', () => {
    setCredentialSlot('claude', 'CLAUDE_CODE_OAUTH_TOKEN_9');
    const p = new ClaudeProvider({ env: oauthEnv });
    // Restore found nothing usable, so the ring stays at its default
    // (primary) — proven the same way as the "no persisted slot" case.
    p.resetRotationCycle();
    expect(p.rotateApiKey()).toEqual({
      rotated: true,
      slot: 'CLAUDE_CODE_OAUTH_TOKEN_2',
      position: 2,
      ringSize: 3,
    });
  });

  it('no persisted slot leaves a fresh instance on the primary', () => {
    const p = new ClaudeProvider({ env: oauthEnv });
    expect(getCredentialSlot('claude')).toBeUndefined();
    // Restore is a no-op with nothing persisted, so the ring position stays
    // at its default (primary) — proven by the first rotation landing on
    // slot 2, not somewhere already advanced.
    p.resetRotationCycle();
    expect(p.rotateApiKey()).toEqual({
      rotated: true,
      slot: 'CLAUDE_CODE_OAUTH_TOKEN_2',
      position: 2,
      ringSize: 3,
    });
  });
});
