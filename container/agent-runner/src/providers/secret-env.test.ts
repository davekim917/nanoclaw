import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';

import { buildSecretEnvVarList, ANTHROPIC_KEY_RE, OAUTH_KEY_RE } from './secret-env.js';

describe('buildSecretEnvVarList', () => {
  let savedEnv: Record<string, string | undefined> = {};
  let touched: string[] = [];
  const BASE_TOUCHED = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_API_KEY_2',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_3',
    'GMAIL_OAUTH_PATH',
    'GMAIL_CREDENTIALS_PATH',
    'NANOCLAW_GH_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ];

  beforeEach(() => {
    touched = [
      ...new Set([
        ...BASE_TOUCHED,
        ...Object.keys(process.env).filter((key) => ANTHROPIC_KEY_RE.test(key) || OAUTH_KEY_RE.test(key)),
      ]),
    ];
    savedEnv = {};
    for (const k of touched) savedEnv[k] = process.env[k];
    for (const k of touched) delete process.env[k];
  });

  afterEach(() => {
    for (const k of touched) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // test_secret_env_list_stable — the list is single-source and deterministic:
  // the two always-present GMAIL paths plus exactly the present Anthropic/OAuth
  // key vars (base + _N), and nothing else. Asserts both the stable tail and
  // that GH tokens are deliberately excluded.
  it('test_secret_env_list_stable', () => {
    // No Anthropic/OAuth keys set → only the two static GMAIL entries.
    expect(buildSecretEnvVarList()).toEqual(['GMAIL_OAUTH_PATH', 'GMAIL_CREDENTIALS_PATH']);

    // With keys present (incl. _N fallbacks) they appear; GH tokens never do.
    process.env.ANTHROPIC_API_KEY = 'sk-base';
    process.env.ANTHROPIC_API_KEY_2 = 'sk-fallback';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-base';
    process.env.CLAUDE_CODE_OAUTH_TOKEN_3 = 'oauth-fallback';
    process.env.NANOCLAW_GH_TOKEN = 'ghp_should_not_appear';
    process.env.GH_TOKEN = 'ghp_should_not_appear';
    process.env.GITHUB_TOKEN = 'ghp_should_not_appear';

    const list = buildSecretEnvVarList();
    expect(list).toContain('ANTHROPIC_API_KEY');
    expect(list).toContain('ANTHROPIC_API_KEY_2');
    expect(list).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(list).toContain('CLAUDE_CODE_OAUTH_TOKEN_3');
    expect(list).toContain('GMAIL_OAUTH_PATH');
    expect(list).toContain('GMAIL_CREDENTIALS_PATH');
    // GH tokens are intentionally NOT stripped (git credential helper relies on them).
    expect(list).not.toContain('NANOCLAW_GH_TOKEN');
    expect(list).not.toContain('GH_TOKEN');
    expect(list).not.toContain('GITHUB_TOKEN');
    // The two static GMAIL paths are always the tail (stable ordering).
    expect(list.slice(-2)).toEqual(['GMAIL_OAUTH_PATH', 'GMAIL_CREDENTIALS_PATH']);
  });

  it('regexes match base + _N variants only', () => {
    expect(ANTHROPIC_KEY_RE.test('ANTHROPIC_API_KEY')).toBe(true);
    expect(ANTHROPIC_KEY_RE.test('ANTHROPIC_API_KEY_5')).toBe(true);
    expect(ANTHROPIC_KEY_RE.test('ANTHROPIC_API_KEY_X')).toBe(false);
    expect(OAUTH_KEY_RE.test('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
    expect(OAUTH_KEY_RE.test('CLAUDE_CODE_OAUTH_TOKEN_2')).toBe(true);
    expect(OAUTH_KEY_RE.test('CLAUDE_CODE_OAUTH_TOKEN_FOO')).toBe(false);
  });

  // test_secret_env_no_sdk_import — secret-env.ts must stay free of the Claude
  // Agent SDK so SDK-less sibling adapters (OpenCode guard, etc.) can import it.
  // Asserted on the module SOURCE: any static `import ... from '@anthropic-ai/...'`
  // or dynamic `import('@anthropic-ai/...')` is a violation. Scanned on IMPORT
  // SYNTAX only (prose mentions of the SDK in doc comments are fine) by
  // stripping line + block comments before matching.
  it('test_secret_env_no_sdk_import', () => {
    const raw = fs.readFileSync(new URL('./secret-env.ts', import.meta.url).pathname, 'utf-8');
    // Strip block comments then line comments so the regex sees only code.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Static import:  import ... from '@anthropic-ai/...'
    expect(/from\s+['"]@anthropic-ai\//.test(code)).toBe(false);
    // Dynamic import:  import('@anthropic-ai/...')  /  require('@anthropic-ai/...')
    expect(/(?:import|require)\s*\(\s*['"]@anthropic-ai\//.test(code)).toBe(false);
    // Bare side-effect import:  import '@anthropic-ai/...'
    expect(/import\s+['"]@anthropic-ai\//.test(code)).toBe(false);
    // Nothing references the SDK package in code at all.
    expect(code).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
