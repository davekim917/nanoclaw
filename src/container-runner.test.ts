import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { dockerResourceLimitArgs, resolveAnthropicAuth, resolveProviderName } from './container-runner.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('dockerResourceLimitArgs', () => {
  it('adds install-wide default resource ceilings', () => {
    expect(dockerResourceLimitArgs()).toEqual([
      '--memory',
      '3g',
      '--memory-reservation',
      '2g',
      '--memory-swap',
      '3g',
      '--pids-limit',
      '512',
    ]);
  });
});

describe('resolveAnthropicAuth', () => {
  it('returns globals when no per-group token is set', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'global-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'global-oauth-3',
      ANTHROPIC_API_KEY: 'global-key',
      ANTHROPIC_API_KEY_5: 'global-key-5',
    };
    const auth = resolveAnthropicAuth('any-folder', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'global-oauth-2' },
      { index: 3, value: 'global-oauth-3' },
    ]);
    expect(auth.apiKeyPrimary).toBe('global-key');
    expect(auth.apiKeyFallbacks).toEqual([{ index: 5, value: 'global-key-5' }]);
  });

  it('returns nothing when neither global nor per-group is set', () => {
    expect(resolveAnthropicAuth('madison-reed', {})).toEqual({
      oauthPrimary: undefined,
      oauthFallbacks: [],
      apiKeyPrimary: undefined,
      apiKeyFallbacks: [],
    });
  });

  it('per-group OAuth wins for the matching folder, ignoring globals entirely', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'global-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_3: 'mr-oauth-3',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    expect(auth.oauthPrimary).toBe('mr-oauth');
    // critical: no leakage from global rotation siblings into the workplace set
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'mr-oauth-2' },
      { index: 3, value: 'mr-oauth-3' },
    ]);
  });

  it('filters the OneCLI "placeholder" sentinel from globals', () => {
    // When the host service is wrapped in `onecli run --`, the wrapper
    // injects CLAUDE_CODE_OAUTH_TOKEN=placeholder as a sentinel that its
    // own proxy substitutes at request time. The literal string is never
    // a real bearer credential — forwarding it into a container that
    // takes the Claude Max OAuth-bypass path strips OneCLI's
    // container-side substitution and emits `401 Invalid bearer token`.
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      ANTHROPIC_API_KEY: 'placeholder',
    };
    const auth = resolveAnthropicAuth('any-folder', env);
    // Placeholder filtered; nothing real to promote → both fully empty.
    expect(auth.oauthPrimary).toBeUndefined();
    expect(auth.apiKeyPrimary).toBeUndefined();
    expect(auth.oauthFallbacks).toEqual([]);
    expect(auth.apiKeyFallbacks).toEqual([]);
  });

  it('promotes first real fallback to primary when global slot is placeholder', () => {
    // Production layout when host service is wrapped in `onecli run --`:
    // the wrapper sets CLAUDE_CODE_OAUTH_TOKEN=placeholder; real values
    // for `_2`/`_3` come from .env. Without promotion, container-runner's
    // `if (hostOauth)` gate would skip forwarding the fallbacks entirely,
    // collapsing non-scoped groups' rotation pool to zero.
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'real-rotation-2',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'real-rotation-3',
    };
    const auth = resolveAnthropicAuth('illysium', env);
    expect(auth.oauthPrimary).toBe('real-rotation-2');
    expect(auth.oauthFallbacks).toEqual([{ index: 3, value: 'real-rotation-3' }]);
  });

  it('placeholder in a scoped slot is also filtered', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_AXIE_DEV: 'placeholder',
    };
    const auth = resolveAnthropicAuth('axie-dev', env);
    // Scoped primary is sentinel → falls back to the global, which is real.
    expect(auth.oauthPrimary).toBe('global-oauth');
  });

  it('per-group token does not leak to other groups', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-oauth-2',
    };
    const auth = resolveAnthropicAuth('illysium', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    // illysium must not see madison-reed siblings
    expect(auth.oauthFallbacks).toEqual([]);
  });

  it('orphan per-group fallbacks (no per-group primary) fall through to global', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-fallback-only',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([]);
  });

  it('hyphens in folder name normalise to underscores', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
    };
    expect(resolveAnthropicAuth('madison-reed', env).oauthPrimary).toBe('mr-oauth');
    expect(resolveAnthropicAuth('Madison-Reed', env).oauthPrimary).toBe('mr-oauth');
  });

  it('digit-only folder name skips per-group resolution to avoid rotation collision', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      // ambiguous: is this folder=2 primary, or rotation slot _2? Treat as rotation.
      CLAUDE_CODE_OAUTH_TOKEN_2: 'ambiguous',
    };
    const auth = resolveAnthropicAuth('2', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([{ index: 2, value: 'ambiguous' }]);
  });

  it('OAuth and API key scope independently', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      ANTHROPIC_API_KEY_MADISON_REED: 'mr-key',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.apiKeyPrimary).toBe('mr-key');
  });

  it('skips empty-string env values', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: '',
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: '',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'global-oauth-3',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    // empty per-group falls through to global
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([{ index: 3, value: 'global-oauth-3' }]);
  });

  it('fallbacks return sorted by index ascending', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'g',
      CLAUDE_CODE_OAUTH_TOKEN_5: 'g5',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'g2',
      CLAUDE_CODE_OAUTH_TOKEN_10: 'g10',
    };
    const auth = resolveAnthropicAuth('any', env);
    expect(auth.oauthFallbacks.map((f) => f.index)).toEqual([2, 5, 10]);
  });
});

describe('codex provider host auth', () => {
  function makeHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-home-'));
  }

  function makeSessionDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-session-'));
  }

  function writeAuth(dir: string, value: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ account: value }));
  }

  function copiedAuth(sessionDir: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'codex', 'auth.json'), 'utf-8'));
  }

  it('copies scoped Codex auth for the agent group folder without DB lookup', () => {
    const home = makeHome();
    const sessionDir = makeSessionDir();
    writeAuth(path.join(home, '.codex'), 'global');
    writeAuth(path.join(home, '.codex-madison-reed-codex'), 'madison-reed');

    const fn = getProviderContainerConfig('codex');
    expect(fn).toBeDefined();
    const contribution = fn!({
      sessionDir,
      agentGroupId: 'ag-does-not-match-folder',
      agentGroupFolder: 'madison-reed-codex',
      hostEnv: { HOME: home } as NodeJS.ProcessEnv,
    });

    expect(copiedAuth(sessionDir)).toEqual({ account: 'madison-reed' });
    expect(contribution.mounts?.[0]).toMatchObject({
      hostPath: path.join(sessionDir, 'codex'),
      containerPath: '/home/node/.codex',
      readonly: false,
    });
  });

  it('falls back to global Codex auth when no scoped auth exists', () => {
    const home = makeHome();
    const sessionDir = makeSessionDir();
    writeAuth(path.join(home, '.codex'), 'global');

    const fn = getProviderContainerConfig('codex');
    expect(fn).toBeDefined();
    fn!({
      sessionDir,
      agentGroupId: 'madison-reed-codex',
      agentGroupFolder: 'madison-reed-codex',
      hostEnv: { HOME: home } as NodeJS.ProcessEnv,
    });

    expect(copiedAuth(sessionDir)).toEqual({ account: 'global' });
  });
});
