import { describe, it, expect } from 'bun:test';
import fs from 'fs';

import { MCP_HEADER_ONLY_SECRET_VARS, ANTHROPIC_KEY_RE, OAUTH_KEY_RE } from './secret-env.js';

describe('secret-env', () => {
  // test_header_only_list_is_exactly_the_mcp_headers — the ONLY list this module
  // still exports for stripping. Provider credentials (Anthropic/OAuth), the GH
  // tokens the URL-scoped git helper needs, and the never-produced GMAIL paths
  // are all absent by design: a container's shell inherits the credential the
  // container runs on, so `claude -p` works headless the way `codex exec` does.
  //
  // MUTATION CHECK: re-adding any ANTHROPIC_API_KEY* / CLAUDE_CODE_OAUTH_TOKEN*
  // name to MCP_HEADER_ONLY_SECRET_VARS fails the exact-equality assertion here
  // AND the "credentials survive" assertions in opencode.failClosed.test.ts and
  // task-script's env test (the Bash rewrite hook never reads this list, so
  // claude.guards.test.ts is unaffected by that mutation).
  it('test_header_only_list_is_exactly_the_mcp_headers', () => {
    expect([...MCP_HEADER_ONLY_SECRET_VARS]).toEqual(['GRANOLA_ACCESS_TOKEN', 'EXA_API_KEY', 'BRAINTRUST_API_KEY']);

    for (const name of MCP_HEADER_ONLY_SECRET_VARS) {
      expect(ANTHROPIC_KEY_RE.test(name)).toBe(false);
      expect(OAUTH_KEY_RE.test(name)).toBe(false);
    }
    for (const never of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_API_KEY_2',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN_3',
      'GMAIL_OAUTH_PATH',
      'GMAIL_CREDENTIALS_PATH',
      'NANOCLAW_GH_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'SNOWFLAKE_PASSWORD',
      'OPENAI_API_KEY',
    ]) {
      expect(MCP_HEADER_ONLY_SECRET_VARS).not.toContain(never);
    }
  });

  // The regexes survive the removal of the unset list: claude-review-service.ts
  // uses them to clear every credential slot from a review child's env before
  // pinning exactly one (claude-review-service.ts:67-75).
  it('regexes match base + _N variants only', () => {
    expect(ANTHROPIC_KEY_RE.test('ANTHROPIC_API_KEY')).toBe(true);
    expect(ANTHROPIC_KEY_RE.test('ANTHROPIC_API_KEY_5')).toBe(true);
    expect(ANTHROPIC_KEY_RE.test('ANTHROPIC_API_KEY_X')).toBe(false);
    expect(OAUTH_KEY_RE.test('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
    expect(OAUTH_KEY_RE.test('CLAUDE_CODE_OAUTH_TOKEN_2')).toBe(true);
    expect(OAUTH_KEY_RE.test('CLAUDE_CODE_OAUTH_TOKEN_FOO')).toBe(false);
  });

  // test_secret_env_no_unset_list — the module must not grow a replacement for
  // the deleted buildSecretEnvVarList: no code here may read process.env at all.
  // Comment prose about the old behaviour is fine, so comments are stripped first.
  it('test_secret_env_no_unset_list', () => {
    const raw = fs.readFileSync(new URL('./secret-env.ts', import.meta.url).pathname, 'utf-8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('process.env');
    expect(code).not.toContain('buildSecretEnvVarList');
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
