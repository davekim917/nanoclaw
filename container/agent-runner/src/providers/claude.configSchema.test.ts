import { describe, it, expect, mock, beforeAll } from 'bun:test';

// Mock the SDK before importing claude.ts, so sdkQuery is interceptable.
// We capture the options passed to sdkQuery to verify sticky config behavior.
let capturedSdkOptions: Record<string, unknown> | null = null;
const mockSdkQuery = mock((_args: unknown) => {
  const args = _args as { options?: Record<string, unknown> };
  capturedSdkOptions = args.options ?? null;
  // Return an async iterable that immediately ends
  return (async function* () {})();
});

// Mock dependent modules to avoid side effects in test environment
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockSdkQuery,
}));

mock.module('../db/connection.js', () => ({
  clearContainerToolInFlight: () => {},
  setContainerToolInFlight: () => {},
}));

mock.module('../worktree-autosave.js', () => ({
  autoCommitDirtyWorktrees: async () => ({ committed: [], failed: [] }),
}));

// Now import the schema and provider (after mocks are set up)
const { claudeConfigSchema } = await import('./claude.js');
const { ClaudeProvider } = await import('./claude.js');

describe('claudeConfigSchema', () => {
  it('test_claudeConfigSchema_valid_effort_max: parses { effort: max }', () => {
    const result = claudeConfigSchema.parse({ effort: 'max' });
    expect(result).toEqual({ effort: 'max' });
  });

  it('test_claudeConfigSchema_invalid_effort_rejected: rejects unknown effort value', () => {
    const result = claudeConfigSchema.safeParse({ effort: 'extreme' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const codes = result.error.issues.map((i) => i.code);
      expect(codes.some((c) => c === 'invalid_enum_value' || c === 'invalid_value')).toBe(true);
    }
  });

  it('test_claudeConfigSchema_unknown_key_rejected: rejects Codex key reasoning_effort', () => {
    const result = claudeConfigSchema.safeParse({ reasoning_effort: 'high' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.message;
      expect(msg.toLowerCase()).toMatch(/reasoning_effort|unrecognized/);
    }
  });

  it('test_claudeConfigSchema_empty_model_rejected: rejects empty string model', () => {
    const result = claudeConfigSchema.safeParse({ model: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.message;
      expect(msg.toLowerCase()).toMatch(/min|length|too_small|too small/);
    }
  });

  it('test_claudeConfigSchema_empty_input_ok: empty object passes', () => {
    const result = claudeConfigSchema.parse({});
    expect(result).toEqual({});
  });
});

describe('ClaudeProvider sticky config', () => {
  it('test_claude_sticky_config_applied_when_input_missing: uses stickyConfig when input has no model/effort', () => {
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();

    const provider = new ClaudeProvider({
      providerConfig: { model: 'claude-opus-4-7', effort: 'high' },
    });

    provider.query({ prompt: 'hi', cwd: '/tmp', continuation: undefined });

    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    expect(capturedSdkOptions?.model).toBe('claude-opus-4-7');
    expect(capturedSdkOptions?.effort).toBe('high');
  });

  it('test_claude_per_turn_input_overrides_sticky: per-turn model overrides stickyConfig', () => {
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();

    const provider = new ClaudeProvider({
      providerConfig: { model: 'claude-opus-4-7' },
    });

    provider.query({ prompt: 'hi', cwd: '/tmp', model: 'claude-sonnet-4-6' });

    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    expect(capturedSdkOptions?.model).toBe('claude-sonnet-4-6');
  });
});
