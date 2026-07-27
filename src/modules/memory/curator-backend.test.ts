import { describe, expect, it, vi } from 'vitest';

import { callClaudeStructured, listClaudeStructuredCredentialSlots } from '../../llm.js';
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
