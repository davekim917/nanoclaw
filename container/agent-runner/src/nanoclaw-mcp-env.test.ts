import { describe, expect, test } from 'bun:test';

import { builtInNanoclawMcpEnv } from './nanoclaw-mcp-env.js';

const gitIdentity = {
  GIT_AUTHOR_NAME: 'Fixture Agent',
  GIT_AUTHOR_EMAIL: 'fixture-agent@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Agent',
  GIT_COMMITTER_EMAIL: 'fixture-agent@example.invalid',
};

describe('builtInNanoclawMcpEnv', () => {
  test('forwards configured author and committer identity through the Codex MCP boundary', () => {
    expect(
      builtInNanoclawMcpEnv({
        NANOCLAW_SESSION_ID: 'fixture-session',
        ...gitIdentity,
      }),
    ).toEqual({
      NANOCLAW_SESSION_ID: 'fixture-session',
      ...gitIdentity,
    });
  });

  test('preserves an inherited human identity from existing scoped credentials', () => {
    expect(builtInNanoclawMcpEnv({ ...gitIdentity })).toEqual(gitIdentity);
  });

  test('keeps the existing MCP environment when no Git identity is present', () => {
    expect(builtInNanoclawMcpEnv({ NANOCLAW_SESSION_ID: 'fixture-session' })).toEqual({
      NANOCLAW_SESSION_ID: 'fixture-session',
    });
  });

  // Oracle change, deliberate: every case above asserts exact equality, which
  // pinned "NANOCLAW_* + identity and nothing else" and so encoded the bug —
  // file-mode GitHub auth needs GITHUB_TOKEN_FILE in the MCP child. The cases
  // below keep exact equality so the boundary stays closed to everything else.
  describe('GitHub credential location', () => {
    const tokenFile = '/run/nanoclaw/gh-token/token';

    test('forwards the token file path and a redirected git config path', () => {
      expect(
        builtInNanoclawMcpEnv({
          NANOCLAW_SESSION_ID: 'fixture-session',
          GITHUB_TOKEN_FILE: tokenFile,
          GIT_CONFIG_GLOBAL: '/tmp/nanoclaw-gitconfig',
        }),
      ).toEqual({
        NANOCLAW_SESSION_ID: 'fixture-session',
        GITHUB_TOKEN_FILE: tokenFile,
        GIT_CONFIG_GLOBAL: '/tmp/nanoclaw-gitconfig',
      });
    });

    test('never forwards a credential value, with or without the file path', () => {
      const secrets = { GH_TOKEN: 'fixture-secret-value', GITHUB_TOKEN: 'fixture-secret-value' };
      expect(builtInNanoclawMcpEnv({ ...secrets, GITHUB_TOKEN_FILE: tokenFile })).toEqual({
        GITHUB_TOKEN_FILE: tokenFile,
      });
      expect(builtInNanoclawMcpEnv(secrets)).toEqual({});
      expect(JSON.stringify(builtInNanoclawMcpEnv({ ...secrets, GITHUB_TOKEN_FILE: tokenFile }))).not.toContain(
        'fixture-secret-value',
      );
    });

    test('does not invent a path when no token was assigned to the group', () => {
      expect(builtInNanoclawMcpEnv({ NANOCLAW_SESSION_ID: 'fixture-session', GITHUB_TOKEN_FILE: '' })).toEqual({
        NANOCLAW_SESSION_ID: 'fixture-session',
      });
    });

    test('drops a value that is not an absolute single-line path', () => {
      expect(
        builtInNanoclawMcpEnv({
          GITHUB_TOKEN_FILE: 'fixture-secret-value',
          GIT_CONFIG_GLOBAL: '/tmp/gitconfig\n[credential]',
        }),
      ).toEqual({});
    });
  });
});
