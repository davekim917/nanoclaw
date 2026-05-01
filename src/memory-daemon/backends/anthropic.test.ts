import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { ClassifierParseError } from '../classifier-client.js';
import { _resetProxyDispatcherForTest, makeAnthropicBackend } from './anthropic.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  _resetProxyDispatcherForTest();
});

const validOutput = {
  worth_storing: true,
  facts: [
    {
      content: 'User prefers dark mode',
      category: 'preference',
      importance: 0.8,
      entities: ['user'],
      source_role: 'user',
    },
  ],
};

function mockFetchOk(text: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: 'text', text }],
        }),
    }),
  );
}

function captureFetch(text: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content: [{ type: 'text', text }] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('anthropic backend', () => {
  it('test_haiku_default_no_thinking', async () => {
    const fetchMock = captureFetch(JSON.stringify(validOutput));
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    const result = await backend('sys prompt', 'user prompt');

    expect(result.worth_storing).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    // Haiku doesn't support extended thinking — no thinking field regardless of effort.
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
  });

  it('test_sonnet_high_effort_enables_extended_thinking', async () => {
    const fetchMock = captureFetch(JSON.stringify(validOutput));
    const backend = makeAnthropicBackend({ model: 'sonnet-4-6', effort: 'high' });
    await backend('sys', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16_000 });
    // max_tokens must exceed thinking budget so output has room.
    expect(body.max_tokens).toBeGreaterThan(16_000);
  });

  it('test_opus_medium_effort_uses_modest_thinking_budget', async () => {
    const fetchMock = captureFetch(JSON.stringify(validOutput));
    const backend = makeAnthropicBackend({ model: 'opus-4-7', effort: 'medium' });
    await backend('sys', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 5_000 });
  });

  it('test_haiku_high_effort_still_no_thinking', async () => {
    // Sanity: requesting high effort on a model that doesn't support extended
    // thinking must NOT add a thinking block (would 400 from API).
    const fetchMock = captureFetch(JSON.stringify(validOutput));
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'high' });
    await backend('sys', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toBeUndefined();
  });

  it('test_unknown_model_alias_throws_at_construction', () => {
    expect(() => makeAnthropicBackend({ model: 'haiku-9000', effort: 'default' })).toThrow(/unknown model alias/);
  });

  it('test_classifier_parses_valid_json', async () => {
    mockFetchOk(JSON.stringify(validOutput));
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    const result = await backend('sys prompt', 'user prompt');

    expect(result.worth_storing).toBe(true);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].category).toBe('preference');
    expect(result.facts[0].source_role).toBe('user');
  });

  it('test_classifier_rejects_invalid_schema', async () => {
    mockFetchOk(JSON.stringify({ worth_storing: 'not-a-boolean', facts: [] }));
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });

    await expect(backend('sys', 'user')).rejects.toThrow(ClassifierParseError);
  });

  it('test_classifier_aborts_on_timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      }),
    );
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });

    await expect(backend('sys', 'user', { timeoutMs: 50 })).rejects.toThrow();
  });

  it('test_classifier_strips_markdown_code_fence', async () => {
    const fenced = '```json\n' + JSON.stringify(validOutput) + '\n```';
    mockFetchOk(fenced);
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    const result = await backend('sys', 'user');
    expect(result.worth_storing).toBe(true);
    expect(result.facts[0].category).toBe('preference');
  });

  it('test_classifier_strips_bare_code_fence', async () => {
    const fenced = '```\n' + JSON.stringify(validOutput) + '\n```';
    mockFetchOk(fenced);
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    const result = await backend('sys', 'user');
    expect(result.worth_storing).toBe(true);
  });

  it('test_classifier_strips_fence_with_trailing_reasoning', async () => {
    const fenced =
      '```json\n' +
      JSON.stringify(validOutput) +
      '\n```\n\n**Reasoning:** This is a fragment of conversation with insufficient context.';
    mockFetchOk(fenced);
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    const result = await backend('sys', 'user');
    expect(result.worth_storing).toBe(true);
    expect(result.facts[0].category).toBe('preference');
  });

  it('test_classifier_extracts_object_from_prose_prefix', async () => {
    const proseWrapped =
      "Sure, here's the JSON: " + JSON.stringify(validOutput) + ' — let me know if you need anything else.';
    mockFetchOk(proseWrapped);
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    const result = await backend('sys', 'user');
    expect(result.worth_storing).toBe(true);
  });

  it('test_classifier_handles_unfenced_json_unchanged', async () => {
    mockFetchOk(JSON.stringify(validOutput));
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    const result = await backend('sys', 'user');
    expect(result.worth_storing).toBe(true);
  });

  it('test_classifier_uses_native_fetch_no_sdk', async () => {
    const src = await import('fs').then((m) =>
      m.readFileSync(new URL('./anthropic.js', import.meta.url).pathname.replace(/\.js$/, '.ts'), 'utf8'),
    );

    expect(src).not.toContain('@anthropic-ai/sdk');
    // Native fetch OR undici (used when HTTPS_PROXY is set for OneCLI gateway).
    expect(/fetch\(|undiciFetch\(|fetchImpl\(/.test(src)).toBe(true);
  });

  it('test_cache_control_ephemeral_set_on_system_block', async () => {
    const fetchMock = captureFetch(JSON.stringify(validOutput));
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    await backend('sys', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toEqual([
      expect.objectContaining({
        type: 'text',
        text: 'sys',
        cache_control: { type: 'ephemeral' },
      }),
    ]);
  });

  it('test_oauth_bearer_when_oauth_token_set', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'placeholder');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const fetchMock = captureFetch(JSON.stringify(validOutput));
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    await backend('sys', 'user');

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.authorization).toBe('Bearer placeholder');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('test_x_api_key_when_direct_key_set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-direct-key');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    const fetchMock = captureFetch(JSON.stringify(validOutput));
    const backend = makeAnthropicBackend({ model: 'haiku-4-5', effort: 'default' });
    await backend('sys', 'user');

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('sk-direct-key');
    expect(headers.authorization).toBeUndefined();
  });
});
