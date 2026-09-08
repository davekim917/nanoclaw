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
});
