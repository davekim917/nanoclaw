import { describe, it, expect, vi, afterEach } from 'vitest';
import { callClassifier, ClassifierParseError, CLASSIFIER_MODEL } from './anthropic-client.js';

afterEach(() => {
  vi.restoreAllMocks();
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

describe('anthropic-client', () => {
  it('test_classifier_parses_valid_json', async () => {
    mockFetchOk(JSON.stringify(validOutput));

    const result = await callClassifier('sys prompt', 'user prompt');

    expect(result.worth_storing).toBe(true);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].category).toBe('preference');
    expect(result.facts[0].source_role).toBe('user');
  });

  it('test_classifier_rejects_invalid_schema', async () => {
    mockFetchOk(JSON.stringify({ worth_storing: 'not-a-boolean', facts: [] }));

    await expect(callClassifier('sys', 'user')).rejects.toThrow(ClassifierParseError);
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

    await expect(callClassifier('sys', 'user', { timeoutMs: 50 })).rejects.toThrow();
  });

  it('test_classifier_strips_markdown_code_fence', async () => {
    // Real-world observation: Haiku 4.5 sometimes wraps JSON output in a
    // ```json fence even when the system prompt asks for raw JSON. The
    // daemon dead-lettered 52 chat turn-pairs from existing illysium history
    // on its first sweep due to this. The parser must handle fenced output.
    const fenced = '```json\n' + JSON.stringify(validOutput) + '\n```';
    mockFetchOk(fenced);
    const result = await callClassifier('sys', 'user');
    expect(result.worth_storing).toBe(true);
    expect(result.facts[0].category).toBe('preference');
  });

  it('test_classifier_strips_bare_code_fence', async () => {
    // Some clients emit ``` without the json language tag.
    const fenced = '```\n' + JSON.stringify(validOutput) + '\n```';
    mockFetchOk(fenced);
    const result = await callClassifier('sys', 'user');
    expect(result.worth_storing).toBe(true);
  });

  it('test_classifier_strips_fence_with_trailing_reasoning', async () => {
    // Real-world Haiku 4.5 shape — fenced JSON followed by free-form prose.
    // Production observation from the daemon's first sweep: many chat
    // turn-pairs were dead-lettered with this exact response pattern.
    const fenced =
      '```json\n' +
      JSON.stringify(validOutput) +
      '\n```\n\n**Reasoning:** This is a fragment of conversation with insufficient context.';
    mockFetchOk(fenced);
    const result = await callClassifier('sys', 'user');
    expect(result.worth_storing).toBe(true);
    expect(result.facts[0].category).toBe('preference');
  });

  it('test_classifier_extracts_object_from_prose_prefix', async () => {
    // Fallback path: no fence, but the model wrote "Here is the JSON: {...}".
    const proseWrapped = "Sure, here's the JSON: " + JSON.stringify(validOutput) + " — let me know if you need anything else.";
    mockFetchOk(proseWrapped);
    const result = await callClassifier('sys', 'user');
    expect(result.worth_storing).toBe(true);
  });

  it('test_classifier_handles_unfenced_json_unchanged', async () => {
    // Sanity: the strip is permissive — raw JSON without fence still parses.
    mockFetchOk(JSON.stringify(validOutput));
    const result = await callClassifier('sys', 'user');
    expect(result.worth_storing).toBe(true);
  });

  it('test_classifier_uses_native_fetch_no_sdk', async () => {
    const src = await import('fs').then((m) =>
      m.readFileSync(new URL('./anthropic-client.js', import.meta.url).pathname.replace(/\.js$/, '.ts'), 'utf8'),
    );

    expect(src).not.toContain('@anthropic-ai/sdk');
    // Either Node's native fetch or undici's fetch (used when HTTPS_PROXY is
    // set so requests honor the OneCLI gateway under Node 20). Both are
    // dependency-free relative to the Anthropic SDK.
    expect(/fetch\(|undiciFetch\(|fetchImpl\(/.test(src)).toBe(true);
    expect(src).toContain(CLASSIFIER_MODEL);
  });
});
