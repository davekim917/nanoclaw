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
    // A bare claude-opus id is normalized to its [1m] form before reaching the
    // SDK so the CLI's auto-compact window stays at 1M under proxy auth (a bare
    // opus id otherwise collapses to a 200k window). See ensureOpus1mSuffix.
    expect(capturedSdkOptions?.model).toBe('claude-opus-4-7[1m]');
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

  it('test_claude_flagless_default_is_opus_alias: no input model + no sticky → model is the opus ALIAS, never undefined', () => {
    // With model undefined the CLI silently uses its pinned built-in default
    // (2.1.156 → opus-4-7, observed live 2026-06-09) instead of the configured
    // ANTHROPIC_DEFAULT_OPUS_MODEL chain. The provider must force the alias.
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();

    const provider = new ClaudeProvider({});

    provider.query({ prompt: 'hi', cwd: '/tmp', continuation: undefined });

    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    expect(capturedSdkOptions?.model).toBe('opus');
  });

  it('test_claude_fable_1m_suffix: bare claude-fable-5 is normalized to its [1m] form', () => {
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();

    const provider = new ClaudeProvider({});

    provider.query({ prompt: 'hi', cwd: '/tmp', model: 'claude-fable-5' });

    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    expect(capturedSdkOptions?.model).toBe('claude-fable-5[1m]');
  });
});

describe('poisoned continuation detection (cross-auth-path thinking signatures)', async () => {
  const { POISONED_CONTINUATION_RE } = await import('./claude.js');

  // Verbatim error text observed in the 2026-06-09 auth-flip drill.
  const DRILL_ERROR = 'API Error: 400 messages.5.content.0: Invalid `signature` in `thinking` block';

  it('test_poisoned_re_matches_drill_text: matches the SDK result text verbatim', () => {
    expect(POISONED_CONTINUATION_RE.test(DRILL_ERROR)).toBe(true);
  });

  it('test_poisoned_re_matches_unbacktick_variant: tolerates a wording change that drops backticks', () => {
    expect(POISONED_CONTINUATION_RE.test('Invalid signature in thinking block')).toBe(true);
  });

  it('test_poisoned_re_no_false_positive: does not match ordinary signature/thinking prose', () => {
    expect(POISONED_CONTINUATION_RE.test('the function signature changed while thinking about the block')).toBe(false);
  });

  it('test_isSessionInvalid_matches_rethrown_error: the re-thrown error engages the stale-session recovery branch', () => {
    const provider = new ClaudeProvider({});
    expect(provider.isSessionInvalid(new Error(DRILL_ERROR))).toBe(true);
  });
});
