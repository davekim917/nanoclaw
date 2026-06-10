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

describe('per-model-family effort defaults', () => {
  const run = (input: Record<string, unknown>, env?: string) => {
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();
    const prev = process.env.NANOCLAW_DEFAULT_EFFORT;
    if (env === undefined) delete process.env.NANOCLAW_DEFAULT_EFFORT;
    else process.env.NANOCLAW_DEFAULT_EFFORT = env;
    try {
      const provider = new ClaudeProvider({});
      provider.query({ prompt: 'hi', cwd: '/tmp', ...input });
      return capturedSdkOptions;
    } finally {
      if (prev === undefined) delete process.env.NANOCLAW_DEFAULT_EFFORT;
      else process.env.NANOCLAW_DEFAULT_EFFORT = prev;
    }
  };

  it('test_effort_default_opus_xhigh: flagless turn (opus alias default) gets xhigh', () => {
    const opts = run({});
    expect(opts?.model).toBe('opus');
    expect(opts?.effort).toBe('xhigh');
  });

  it('test_effort_default_fable_high: -m fable without -e defaults to high (2x-cost model, docs-recommended default)', () => {
    const opts = run({ model: 'claude-fable-5[1m]' });
    expect(opts?.effort).toBe('high');
  });

  it('test_effort_flag_wins_on_fable: -e xhigh on fable overrides the family default', () => {
    const opts = run({ model: 'claude-fable-5[1m]', effort: 'xhigh' });
    expect(opts?.effort).toBe('xhigh');
  });

  it('test_effort_default_haiku_none: haiku gets no effort option (no API-level effort support)', () => {
    const opts = run({ model: 'claude-haiku-4-5' });
    expect(opts?.effort).toBeUndefined();
  });

  it('test_effort_default_sonnet_high: sonnet family defaults to high (rejects xhigh)', () => {
    const opts = run({ model: 'claude-sonnet-4-6' });
    expect(opts?.effort).toBe('high');
  });

  it('test_effort_operator_env_overrides_family_default: NANOCLAW_DEFAULT_EFFORT beats the family default', () => {
    const opts = run({}, 'medium');
    expect(opts?.effort).toBe('medium');
  });

  it('test_effort_flag_beats_operator_env: explicit -e wins over the operator env override', () => {
    const opts = run({ effort: 'low' }, 'medium');
    expect(opts?.effort).toBe('low');
  });

  it('test_effort_clamp_sticky_xhigh_on_sonnet: sticky xhigh + model switch to sonnet clamps to high (sonnet rejects xhigh)', () => {
    const opts = run({ model: 'claude-sonnet-4-6', effort: 'xhigh' });
    expect(opts?.effort).toBe('high');
  });

  it('test_effort_clamp_operator_env_on_sonnet: model-blind operator override xhigh clamps for sonnet turns', () => {
    const opts = run({ model: 'claude-sonnet-4-6' }, 'xhigh');
    expect(opts?.effort).toBe('high');
  });

  it('test_effort_clamp_opus46_no_xhigh: opus 4.6 has no xhigh — flagless default and explicit xhigh both land on high', () => {
    const flagless = run({ model: 'claude-opus-4-6[1m]' });
    expect(flagless?.effort).toBe('high');
    const explicit = run({ model: 'claude-opus-4-6[1m]', effort: 'xhigh' });
    expect(explicit?.effort).toBe('high');
  });

  it('test_effort_clamp_haiku_drops_any_effort: haiku drops even an explicit effort (no API support)', () => {
    const opts = run({ model: 'claude-haiku-4-5', effort: 'high' });
    expect(opts?.effort).toBeUndefined();
  });

  it('test_effort_no_clamp_max_on_sonnet: max is valid on sonnet and passes through', () => {
    const opts = run({ model: 'claude-sonnet-4-6', effort: 'max' });
    expect(opts?.effort).toBe('max');
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
