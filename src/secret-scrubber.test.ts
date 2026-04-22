import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { _clearSecretsForTest, registerSecrets, registerSecretsFromEnv, scrubSecrets } from './secret-scrubber.js';

describe('secret-scrubber', () => {
  beforeEach(() => _clearSecretsForTest());

  it('returns text unchanged when nothing is registered AND no secret shapes match', () => {
    expect(scrubSecrets('My regular sentence with no secrets.')).toBe('My regular sentence with no secrets.');
  });

  it('scrubs secret shapes even when .env registry is empty', () => {
    expect(scrubSecrets('Authorization: Bearer abcdefghijklmnop ok')).toBe('Authorization: [REDACTED] ok');
    expect(scrubSecrets('tok ghp_1234567890abcdefghij end')).toBe('tok [REDACTED] end');
    expect(scrubSecrets('tok xoxb-1234-abcd-efgh end')).toBe('tok [REDACTED] end');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456';
    expect(scrubSecrets(`jwt ${jwt} end`)).toBe('jwt [REDACTED] end');
  });

  it('scrubs high-entropy opaque tokens ≥40 chars', () => {
    const fakeToken = 'A'.repeat(45);
    expect(scrubSecrets(`tok ${fakeToken} end`)).toBe('tok [REDACTED] end');
  });

  it('does NOT scrub UUIDs (36 chars) — below the entropy threshold', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(scrubSecrets(`uuid ${uuid} end`)).toBe(`uuid ${uuid} end`);
  });

  it('scrubs URL query param secrets', () => {
    expect(scrubSecrets('https://api.example.com/v1?api_key=xxx&other=ok')).toBe(
      'https://api.example.com/v1?api_key=[REDACTED]&other=ok',
    );
  });

  it('redacts a registered value', () => {
    registerSecrets({ ANTHROPIC_API_KEY: 'sk-ant-1234567890abcdef' });
    expect(scrubSecrets('Key: sk-ant-1234567890abcdef ok')).toBe('Key: [REDACTED] ok');
  });

  it('redacts multiple occurrences of the same value', () => {
    registerSecrets({ T: 'abcdefgh' });
    expect(scrubSecrets('abcdefgh-abcdefgh')).toBe('[REDACTED]-[REDACTED]');
  });

  it('redacts multiple distinct secrets independently', () => {
    registerSecrets({ A: 'aaaaaaaa', B: 'bbbbbbbb' });
    expect(scrubSecrets('one aaaaaaaa two bbbbbbbb three')).toBe('one [REDACTED] two [REDACTED] three');
  });

  it('ignores values shorter than the minimum length', () => {
    registerSecrets({ SHORT: 'abc' });
    expect(scrubSecrets('abc abc abc')).toBe('abc abc abc');
  });

  it('ignores empty values', () => {
    registerSecrets({ EMPTY: '' });
    expect(scrubSecrets('anything')).toBe('anything');
  });

  it('returns text unchanged when text is empty', () => {
    registerSecrets({ A: 'aaaaaaaa' });
    expect(scrubSecrets('')).toBe('');
  });
});

describe('registerSecretsFromEnv', () => {
  beforeEach(() => _clearSecretsForTest());

  function writeEnv(contents: string): string {
    const file = path.join(os.tmpdir(), `scrubber-test-${Date.now()}-${Math.random()}.env`);
    fs.writeFileSync(file, contents);
    return file;
  }

  it('registers credential-shaped keys', () => {
    const file = writeEnv(
      [
        'ANTHROPIC_API_KEY=sk-ant-1234567890abcdef',
        'SLACK_BOT_TOKEN_ILLYSIUM=xoxb-realtokenvalue123',
        'GOOGLE_OAUTH_CLIENT_SECRET=oauthsecretxyz1234',
        'RENDER_PG_URL_ILLYSIUM_MAIN=postgres://userpass@host/db',
        'RENDER_PG_ILLYSIUM_XZO_TENANTS=postgres://anotheruser@host/db2',
      ].join('\n'),
    );
    const count = registerSecretsFromEnv(file);
    expect(count).toBe(5);
    expect(scrubSecrets('key sk-ant-1234567890abcdef end')).toBe('key [REDACTED] end');
    expect(scrubSecrets('slack xoxb-realtokenvalue123 ok')).toBe('slack [REDACTED] ok');
    expect(scrubSecrets('pg postgres://userpass@host/db here')).toBe('pg [REDACTED] here');
    fs.unlinkSync(file);
  });

  it('does NOT register config-shaped keys (the v1→v2 regression)', () => {
    // These are the actual kinds of keys that over-redacted on Dave's install:
    // short config values whose keys did not match the old NON_SECRET blacklist,
    // so they got scrubbed out of every outbound message.
    const file = writeEnv(
      [
        'NANOCLAW_DEFAULT_AGENT_GROUP_SLACK_ILLYSIUM=illysium',
        'NANOCLAW_DEFAULT_SESSION_MODE_SLACK_ILLYSIUM=per-sender',
        'ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7',
        'DISCORD_SLASH_CHANNEL_IDS=1234567890,0987654321',
        'RENDER_WORKSPACE_ID_ILLYSIUM=tea-abcdefghijklmnopqr12',
      ].join('\n'),
    );
    const count = registerSecretsFromEnv(file);
    expect(count).toBe(0);
    expect(scrubSecrets('Hey Dave — illysium here.')).toBe('Hey Dave — illysium here.');
    expect(scrubSecrets('Running on claude-opus-4-7.')).toBe('Running on claude-opus-4-7.');
    fs.unlinkSync(file);
  });

  it('handles quoted values and strips the quotes', () => {
    const file = writeEnv('MY_API_KEY="quotedsecret1234"');
    registerSecretsFromEnv(file);
    expect(scrubSecrets('v=quotedsecret1234 end')).toBe('v=[REDACTED] end');
    fs.unlinkSync(file);
  });

  it('skips values shorter than the minimum length', () => {
    const file = writeEnv('SHORT_KEY=abc');
    const count = registerSecretsFromEnv(file);
    expect(count).toBe(0);
    fs.unlinkSync(file);
  });
});
