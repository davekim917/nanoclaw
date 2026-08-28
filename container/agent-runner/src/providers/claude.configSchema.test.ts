import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock the SDK before importing claude.ts, so sdkQuery is interceptable.
// We capture the options passed to sdkQuery to verify sticky config behavior.
let capturedSdkOptions: Record<string, unknown> | null = null;
let capturedSetModel: Array<string | undefined> = [];
let capturedFlagSettings: Array<Record<string, unknown>> = [];
const mockSdkQuery = mock((_args: unknown) => {
  const args = _args as { options?: Record<string, unknown> };
  capturedSdkOptions = args.options ?? null;
  // Async iterable that immediately ends, plus the live-control surface
  // (setModel / applyFlagSettings) that applySettings exercises.
  const gen = (async function* () {})() as AsyncGenerator & {
    setModel: (m?: string) => Promise<void>;
    applyFlagSettings: (s: Record<string, unknown>) => Promise<void>;
  };
  gen.setModel = (m?: string) => {
    capturedSetModel.push(m);
    return Promise.resolve();
  };
  gen.applyFlagSettings = (s: Record<string, unknown>) => {
    capturedFlagSettings.push(s);
    return Promise.resolve();
  };
  return gen;
});

// Mock dependent modules to avoid side effects in test environment
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockSdkQuery,
}));

// Spread the real module and stub only the tool-in-flight markers —
// bun's mock.module leaks across test files in the same process, and a
// bare two-export mock strips getOutboundDb/transaction from later files
// (task-script.test.ts markScriptSkipped went red on exactly this).
const realConnection = await import('../db/connection.js');
mock.module('../db/connection.js', () => ({
  ...realConnection,
  clearContainerToolInFlight: () => {},
  setContainerToolInFlight: () => {},
}));

mock.module('../worktree-autosave.js', () => ({
  autoCommitDirtyWorktrees: async () => ({ committed: [], failed: [] }),
}));

// Now import the schema and provider (after mocks are set up)
const { CLAUDE_EFFORT_LEVELS, claudeConfigSchema, discoverPlugins } = await import('./claude.js');
const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const TEST_CLAUDE_CONFIG_DIR = '/tmp/nanoclaw-claude-config-schema';
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

beforeAll(() => {
  fs.rmSync(TEST_CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_CLAUDE_CONFIG_DIR, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = TEST_CLAUDE_CONFIG_DIR;
});

afterAll(() => {
  fs.rmSync(TEST_CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
});

function makeClaudeProvider(
  options: ConstructorParameters<typeof ClaudeProvider>[0] = {},
): InstanceType<typeof ClaudeProvider> {
  const provider = new ClaudeProvider(options);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider;
}

describe('claudeConfigSchema', () => {
  it('test_claude_effort_contract: the runtime schema exposes the SDK effort surface', () => {
    expect(CLAUDE_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

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

describe('Claude plugin discovery', () => {
  it('reads an explicit NanoClaw Bash-email guard capability from a loaded plugin', () => {
    const pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-plugin-discovery-'));
    try {
      const workflow = path.join(pluginsRoot, 'bootstrap', 'workflow');
      fs.mkdirSync(path.join(workflow, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(workflow, '.claude-plugin', 'plugin.json'), '{"name":"bootstrap-workflow"}');
      fs.writeFileSync(path.join(workflow, 'nanoclaw-plugin.json'), '{"preToolUseGuards":["bash-email"]}');

      const discovery = discoverPlugins(pluginsRoot);
      expect(discovery.plugins).toEqual([{ type: 'local', path: workflow }]);
      expect(discovery.preToolUseGuards).toEqual(['bash-email']);
    } finally {
      fs.rmSync(pluginsRoot, { recursive: true, force: true });
    }
  });

  it('gives a declared Bootstrap Bash-email guard sole ownership of the gate', () => {
    const pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-plugin-owner-'));
    const originalPluginsRoot = process.env.CLAUDE_PLUGINS_ROOT;
    try {
      const workflow = path.join(pluginsRoot, 'bootstrap', 'workflow');
      fs.mkdirSync(path.join(workflow, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(workflow, '.claude-plugin', 'plugin.json'), '{"name":"bootstrap-workflow"}');
      fs.writeFileSync(path.join(workflow, 'nanoclaw-plugin.json'), '{"preToolUseGuards":["bash-email"]}');
      process.env.CLAUDE_PLUGINS_ROOT = pluginsRoot;
      capturedSdkOptions = null;
      mockSdkQuery.mockClear();

      makeClaudeProvider().query({ prompt: 'hi', cwd: '/tmp', continuation: undefined });

      const hooks = capturedSdkOptions?.hooks as { PreToolUse?: Array<{ hooks?: unknown[] }> } | undefined;
      // The native Email gate would be the seventh Bash hook (sanitize,
      // managed-Git maintenance, self-approval, snowflake, git-clone,
      // codex-companion). Its absence
      // makes the declared plugin the sole
      // owner and prevents duplicate cards.
      expect(hooks?.PreToolUse?.[0]?.hooks).toHaveLength(6);
      expect(capturedSdkOptions?.plugins).toEqual([{ type: 'local', path: workflow }]);
    } finally {
      if (originalPluginsRoot === undefined) delete process.env.CLAUDE_PLUGINS_ROOT;
      else process.env.CLAUDE_PLUGINS_ROOT = originalPluginsRoot;
      fs.rmSync(pluginsRoot, { recursive: true, force: true });
    }
  });
});

describe('ClaudeProvider sticky config', () => {
  it('test_claude_sticky_config_applied_when_input_missing: uses stickyConfig when input has no model/effort', () => {
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();

    const provider = makeClaudeProvider({
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

    const provider = makeClaudeProvider({
      providerConfig: { model: 'claude-opus-4-7' },
    });

    provider.query({ prompt: 'hi', cwd: '/tmp', model: 'claude-sonnet-5' });

    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    expect(capturedSdkOptions?.model).toBe('claude-sonnet-5');
  });

  it('test_claude_flagless_default_is_opus_alias: no input model + no sticky → model is the opus ALIAS, never undefined', () => {
    // With model undefined the CLI silently uses its pinned built-in default
    // (2.1.156 → opus-4-7, observed live 2026-06-09) instead of the configured
    // ANTHROPIC_DEFAULT_OPUS_MODEL chain. The provider must force the alias.
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();

    const provider = makeClaudeProvider({});

    provider.query({ prompt: 'hi', cwd: '/tmp', continuation: undefined });

    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    expect(capturedSdkOptions?.model).toBe('opus');
  });

  it('test_claude_fable_1m_suffix: bare claude-fable-5 is normalized to its [1m] form', () => {
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();

    const provider = makeClaudeProvider({});

    provider.query({ prompt: 'hi', cwd: '/tmp', model: 'claude-fable-5' });

    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    expect(capturedSdkOptions?.model).toBe('claude-fable-5[1m]');
  });
});

describe('per-model-family effort defaults', () => {
  const run = (input: Record<string, unknown>, env?: string) => {
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();
    const prev = process.env.NANOCLAW_EFFORT_OVERRIDE;
    if (env === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
    else process.env.NANOCLAW_EFFORT_OVERRIDE = env;
    try {
      const provider = makeClaudeProvider({});
      provider.query({ prompt: 'hi', cwd: '/tmp', ...input });
      return capturedSdkOptions;
    } finally {
      if (prev === undefined) delete process.env.NANOCLAW_EFFORT_OVERRIDE;
      else process.env.NANOCLAW_EFFORT_OVERRIDE = prev;
    }
  };

  it('test_effort_default_opus5_high: flagless turn (opus alias default → Opus 5) gets high', () => {
    const opts = run({});
    expect(opts?.model).toBe('opus');
    expect(opts?.effort).toBe('high');
  });

  // The concrete id the `opus` alias now resolves to (claude-opus-5[1m]).
  // Operator decision 2026-07-27: Opus 5 defaults to `high` for parity with
  // the Codex gpt-5.6-sol default. The clamp path keeps xhigh available, so an
  // explicit `-e xhigh` still survives (guarded by the next test).
  it('test_effort_default_opus5_high_explicit_id: explicit claude-opus-5[1m] defaults to high', () => {
    const opts = run({ model: 'claude-opus-5[1m]' });
    expect(opts?.model).toBe('claude-opus-5[1m]');
    expect(opts?.effort).toBe('high');
  });

  it('test_effort_xhigh_on_opus5_not_clamped: an explicit -e xhigh survives on Opus 5', () => {
    const opts = run({ model: 'claude-opus-5[1m]', effort: 'xhigh' });
    expect(opts?.effort).toBe('xhigh');
  });

  it('test_effort_default_fable_medium: -m fable without -e defaults to medium', () => {
    const opts = run({ model: 'claude-fable-5[1m]' });
    expect(opts?.effort).toBe('medium');
  });

  it('test_effort_flag_wins_on_fable: -e xhigh on fable overrides the family default', () => {
    const opts = run({ model: 'claude-fable-5[1m]', effort: 'xhigh' });
    expect(opts?.effort).toBe('xhigh');
  });

  it('test_effort_default_haiku_none: haiku gets no effort option (no API-level effort support)', () => {
    const opts = run({ model: 'claude-haiku-4-5' });
    expect(opts?.effort).toBeUndefined();
  });

  it('test_effort_default_sonnet_xhigh: Sonnet 5 defaults to xhigh (fleet default)', () => {
    const opts = run({ model: 'claude-sonnet-5' });
    expect(opts?.effort).toBe('xhigh');
  });

  it('test_effort_operator_env_overrides_family_default: NANOCLAW_EFFORT_OVERRIDE beats the family default', () => {
    const opts = run({}, 'medium');
    expect(opts?.effort).toBe('medium');
  });

  it('test_effort_flag_beats_operator_env: explicit -e wins over the operator env override', () => {
    const opts = run({ effort: 'low' }, 'medium');
    expect(opts?.effort).toBe('low');
  });

  it('test_effort_xhigh_on_sonnet5_passes: Sonnet 5 supports xhigh, so an explicit -e xhigh is not clamped', () => {
    const opts = run({ model: 'claude-sonnet-5', effort: 'xhigh' });
    expect(opts?.effort).toBe('xhigh');
  });

  it('test_effort_operator_env_xhigh_on_sonnet5: operator override xhigh passes through on Sonnet 5', () => {
    const opts = run({ model: 'claude-sonnet-5' }, 'xhigh');
    expect(opts?.effort).toBe('xhigh');
  });

  it('test_effort_all_opus_default_high: all opus models (5+, older) default to high', () => {
    const flagless = run({ model: 'claude-opus-4-6[1m]' });
    expect(flagless?.effort).toBe('high');
    const flagless5 = run({ model: 'claude-opus-5[1m]' });
    expect(flagless5?.effort).toBe('high');
  });

  it('test_effort_xhigh_survives_on_all_opus: explicit -e xhigh passes through on any opus model', () => {
    // Pre-5 opus ids (4.6 etc.) are no longer used, but xhigh passes through
    // regardless — only haiku clamps, every other model gets the full surface.
    const explicit = run({ model: 'claude-opus-4-6[1m]', effort: 'xhigh' });
    expect(explicit?.effort).toBe('xhigh');
  });

  it('test_effort_clamp_haiku_drops_any_effort: haiku drops even an explicit effort (no API support)', () => {
    const opts = run({ model: 'claude-haiku-4-5', effort: 'high' });
    expect(opts?.effort).toBeUndefined();
  });

  it('test_effort_no_clamp_max_on_sonnet: max is valid on sonnet and passes through', () => {
    const opts = run({ model: 'claude-sonnet-5', effort: 'max' });
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
    const provider = makeClaudeProvider({});
    expect(provider.isSessionInvalid(new Error(DRILL_ERROR))).toBe(true);
  });
});

describe('live applySettings (-m/-e on an active query — same conversation, no teardown)', () => {
  const start = (input: Record<string, unknown> = {}) => {
    capturedSetModel = [];
    capturedFlagSettings = [];
    mockSdkQuery.mockClear();
    const provider = makeClaudeProvider({});
    return provider.query({ prompt: 'hi', cwd: '/tmp', ...input });
  };

  it('test_applySettings_model_switch: -m fable mid-turn → setModel + family-default effort', async () => {
    const q = start(); // opus @ high (Opus 5 default as of 2026-07-27)
    await q.applySettings!({ model: 'claude-fable-5[1m]' });
    expect(capturedSetModel).toEqual(['claude-fable-5[1m]']);
    expect(capturedFlagSettings).toEqual([{ effortLevel: 'medium' }]);
  });

  it('test_applySettings_effort_only: -e medium mid-turn → no setModel, effortLevel applied', async () => {
    const q = start();
    await q.applySettings!({ effort: 'medium' });
    expect(capturedSetModel).toEqual([]);
    expect(capturedFlagSettings).toEqual([{ effortLevel: 'medium' }]);
  });

  it('test_applySettings_xhigh_on_sonnet5_live: Sonnet 5 + xhigh passes through live (no clamp)', async () => {
    const q = start();
    await q.applySettings!({ model: 'claude-sonnet-5', effort: 'xhigh' });
    expect(capturedSetModel).toEqual(['claude-sonnet-5']);
    expect(capturedFlagSettings).toEqual([{ effortLevel: 'xhigh' }]);
  });

  it('test_applySettings_max_throws: effortLevel control cannot express max → caller falls back to reopen', async () => {
    const q = start();
    await expect(q.applySettings!({ effort: 'max' })).rejects.toThrow(/max/);
    expect(capturedFlagSettings).toEqual([]);
  });

  it('test_applySettings_bare_fable_gets_1m: bare id normalized before setModel', async () => {
    const q = start();
    await q.applySettings!({ model: 'claude-fable-5' });
    expect(capturedSetModel).toEqual(['claude-fable-5[1m]']);
  });
});

describe('subagent model env', () => {
  it('test_claude_no_subagent_model_pin: perQueryEnv omits CLAUDE_CODE_SUBAGENT_MODEL and pins only the matching family alias', () => {
    // CLAUDE_CODE_SUBAGENT_MODEL outranks per-invocation and frontmatter model
    // selection — setting it would pin every subagent to the group model.
    capturedSdkOptions = null;
    mockSdkQuery.mockClear();

    const provider = makeClaudeProvider({});
    provider.query({ prompt: 'hi', cwd: '/tmp', model: 'claude-sonnet-5' });

    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    const env = capturedSdkOptions?.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-5');
    // Cross-family aliases stay untouched so explicit frontmatter choices resolve freely.
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });
});

describe('container GitNexus retirement', () => {
  it('test_claude_plugin_discovery_preserves_non_gitnexus_plugins', () => {
    const pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plugin-discovery-'));
    const pluginDir = path.join(pluginsRoot, 'ordinary-plugin');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'ordinary-plugin' }),
    );

    const previousRoot = process.env.CLAUDE_PLUGINS_ROOT;
    try {
      process.env.CLAUDE_PLUGINS_ROOT = pluginsRoot;
      capturedSdkOptions = null;
      mockSdkQuery.mockClear();
      makeClaudeProvider({}).query({ prompt: 'hi', cwd: '/tmp' });

      expect(capturedSdkOptions?.plugins).toEqual([{ type: 'local', path: pluginDir }]);
      const source = fs.readFileSync(new URL('./claude.ts', import.meta.url), 'utf8');
      expect(source).not.toContain('prepareGitNexusPluginForClaude');
      expect(source).not.toContain('gitnexus-runtime');
      expect(source).not.toContain('nanoclaw-plugin-overlays');
    } finally {
      if (previousRoot === undefined) delete process.env.CLAUDE_PLUGINS_ROOT;
      else process.env.CLAUDE_PLUGINS_ROOT = previousRoot;
      fs.rmSync(pluginsRoot, { recursive: true, force: true });
    }
  });

  it('test_runner_startup_has_no_gitnexus_runtime_setup', () => {
    const runnerSource = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(runnerSource).not.toMatch(/GitNexus|gitnexus|GITNEXUS_INJECT_AGENTS_MD/);
    expect(runnerSource).not.toContain('configureGitNexusRuntime');
    expect(fs.existsSync(new URL('../gitnexus-runtime.ts', import.meta.url))).toBe(false);
  });
});
