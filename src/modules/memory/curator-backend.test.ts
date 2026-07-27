import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess, ExecFileException } from 'child_process';

import { describe, expect, it, vi } from 'vitest';

import {
  callClaudeCliStructured,
  callClaudeStructured,
  listClaudeStructuredCredentialSlots,
  type ClaudeCliExecFile,
} from '../../llm.js';
import { CURATOR_OUTPUT_SCHEMA } from './curator-contract.js';
import {
  type CuratorModelCall,
  MEMORY_CURATOR_EFFORT,
  MEMORY_CURATOR_MODEL,
  MemoryCuratorBackend,
} from './curator-backend.js';

describe('memory curator backend', () => {
  it('locks the selected model and effort with no fallback surface', async () => {
    const call = vi.fn(async (request, _options?: { credentialSlot?: string }) => ({
      value: { action: 'noop', evidenceIds: [], reasonCode: 'transient' } as const,
      model: request.model,
      credentialSlot: 'oauth:2' as const,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    }));
    const result = await new MemoryCuratorBackend(call as unknown as CuratorModelCall).curate(
      'system',
      'user',
      'oauth:primary',
    );
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]![0]).toMatchObject({
      model: MEMORY_CURATOR_MODEL,
      effort: MEMORY_CURATOR_EFFORT,
      maxTokens: 8192,
      timeoutMs: 120000,
    });
    expect(call.mock.calls[0]![1]).toEqual({ credentialSlot: 'oauth:primary' });
    expect(result.decision.action).toBe('noop');
  });

  it('discovers ordered unique OAuth slots without mixing in API billing', () => {
    expect(
      listClaudeStructuredCredentialSlots({
        CLAUDE_CODE_OAUTH_TOKEN: 'primary',
        CLAUDE_CODE_OAUTH_TOKEN_2: 'secondary',
        CLAUDE_CODE_OAUTH_TOKEN_3: 'secondary',
        ANTHROPIC_API_KEY: 'billable-api-key',
      }),
    ).toEqual(['oauth:primary', 'oauth:2']);
    expect(listClaudeStructuredCredentialSlots({ ANTHROPIC_API_KEY: 'api-key' })).toEqual(['api-key:primary']);
    expect(
      listClaudeStructuredCredentialSlots(
        {
          CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
          CLAUDE_CODE_OAUTH_TOKEN_2: 'secondary',
        },
        { CLAUDE_CODE_OAUTH_TOKEN: 'recovered-primary' },
      ),
    ).toEqual(['oauth:primary', 'oauth:2']);
  });

  it('runs the curator through Claude Code with one isolated OAuth slot and stdin payload', async () => {
    let stdin = '';
    const execFile = vi.fn(((_command: string, _args: string[], _options, callback) => {
      const child = new EventEmitter() as ChildProcess;
      child.stdin = new PassThrough();
      child.kill = vi.fn(() => true);
      child.stdin.on('data', (chunk) => {
        stdin += chunk.toString();
      });
      queueMicrotask(() => {
        callback(
          null,
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            structured_output: { action: 'noop' },
            usage: {
              input_tokens: 7,
              output_tokens: 3,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 1,
            },
            modelUsage: { 'claude-sonnet-5': { inputTokens: 7, outputTokens: 3 } },
          }),
          '',
        );
      });
      return child;
    }) satisfies ClaudeCliExecFile);
    const result = await callClaudeCliStructured<{ action: string }>(
      {
        model: 'claude-sonnet-5',
        effort: 'medium',
        system: 'fixed curator rules',
        user: 'secret episode payload that must not enter argv',
        schema: { type: 'object' },
        maxTokens: 8192,
        timeoutMs: 1000,
      },
      {
        env: {
          PATH: process.env.PATH,
          NO_PROXY: 'localhost,127.0.0.1',
          CLAUDE_BIN: '/opt/claude',
          CLAUDE_CODE_OAUTH_TOKEN: 'primary-secret',
          CLAUDE_CODE_OAUTH_TOKEN_2: 'secondary-secret',
          CLAUDE_CODE_OAUTH_TOKEN_3: 'tertiary-secret',
          ANTHROPIC_API_KEY: 'api-secret',
        },
        envFile: { CLAUDE_CODE_OAUTH_TOKEN: 'recovered-primary' },
        credentialSlot: 'oauth:2',
        execFile,
      },
    );
    expect(result).toMatchObject({
      value: { action: 'noop' },
      model: 'claude-sonnet-5',
      credentialSlot: 'oauth:2',
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
    });
    expect(stdin).toBe('secret episode payload that must not enter argv');
    const [command, args, options] = execFile.mock.calls[0]!;
    expect(command).toBe('/opt/claude');
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--model',
        'claude-sonnet-5',
        '--effort',
        'medium',
        '--tools',
        '',
        '--safe-mode',
        '--no-session-persistence',
        '--prompt-suggestions',
        'false',
      ]),
    );
    expect(args).not.toContain('secret episode payload that must not enter argv');
    expect(options.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'secondary-secret',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
      NO_PROXY: 'localhost,127.0.0.1,api.anthropic.com',
      no_proxy: 'localhost,127.0.0.1,api.anthropic.com',
    });
    expect(options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN_2');
    expect(options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN_3');
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('preserves Claude Code quota status so the worker can fail over slots', async () => {
    const execFile = vi.fn(((_command: string, _args: string[], _options, callback) => {
      const child = new EventEmitter() as ChildProcess;
      child.stdin = new PassThrough();
      child.kill = vi.fn(() => true);
      queueMicrotask(() => {
        callback(
          Object.assign(new Error('exit 1'), { code: 1 }) as ExecFileException,
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: true,
            api_error_status: 429,
            result: 'This request would exceed your account rate limit.',
          }),
          '',
        );
      });
      return child;
    }) satisfies ClaudeCliExecFile);
    await expect(
      callClaudeCliStructured(
        {
          model: 'claude-sonnet-5',
          effort: 'medium',
          system: 'system',
          user: 'user',
          schema: { type: 'object' },
          maxTokens: 100,
          timeoutMs: 1000,
        },
        {
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'primary-secret' },
          credentialSlot: 'oauth:primary',
          execFile,
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Claude CLI call failed/),
      status: 429,
    });
  });

  it('sends adaptive thinking plus schema and verifies the returned model', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'claude-sonnet-5',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema' } },
      });
      return new Response(
        JSON.stringify({
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"action":"noop"}' }],
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
        { status: 200 },
      );
    });
    const result = await callClaudeStructured<{ action: string }>(
      {
        model: 'claude-sonnet-5',
        effort: 'medium',
        system: 'system',
        user: 'user',
        schema: { type: 'object' },
        maxTokens: 100,
        timeoutMs: 1000,
      },
      {
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: 'primary-secret',
          CLAUDE_CODE_OAUTH_TOKEN_2: 'secondary-secret',
        },
        fetch,
        credentialSlot: 'oauth:2',
      },
    );
    expect(result.credentialSlot).toBe('oauth:2');
    expect(result.value).toEqual({ action: 'noop' });
  });

  it('keeps unsupported collection limits out of the raw structured-output schema', () => {
    expect(JSON.stringify(CURATOR_OUTPUT_SCHEMA)).not.toContain('maxItems');
  });

  it('fails closed on model drift, refusal, and HTTP errors', async () => {
    const request = {
      model: 'claude-sonnet-5',
      effort: 'medium' as const,
      system: 'system',
      user: 'user',
      schema: { type: 'object' },
      maxTokens: 100,
      timeoutMs: 1000,
    };
    await expect(
      callClaudeStructured(request, {
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'primary-secret' },
        fetch: async () =>
          new Response(
            JSON.stringify({
              model: 'claude-sonnet-5-latest',
              content: [{ type: 'text', text: '{}' }],
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toThrow(/model mismatch/);
    await expect(
      callClaudeStructured(request, {
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'primary-secret' },
        fetch: async () =>
          new Response(
            JSON.stringify({
              model: 'claude-sonnet-5',
              stop_reason: 'refusal',
              content: [{ type: 'text', text: '{}' }],
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toThrow(/refused/);
    await expect(
      callClaudeStructured(request, {
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'primary-secret' },
        fetch: async () =>
          new Response(
            JSON.stringify({
              type: 'error',
              error: { type: 'rate_limit_error', message: 'Please retry later' },
            }),
            { status: 429, headers: { 'request-id': 'req_test' } },
          ),
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/429.*rate_limit_error.*Please retry later/),
      status: 429,
      providerErrorType: 'rate_limit_error',
      requestId: 'req_test',
    });
  });
});
