import { describe, expect, it } from 'bun:test';

import { createCodexConfigOverrides } from './codex-app-server.js';
import { buildCodexSubagentLifecycleInstructions, CodexProvider, codexConfigSchema } from './codex.js';
import { getProviderConfigSchema, validateProviderConfig } from './provider-registry.js';

// Importing the providers barrel triggers all `registerProvider*` calls so the
// "after barrel import" assertions reflect the wired state, not module-load
// order accidents.
import './index.js';

describe('codexConfigSchema', () => {
  it('test_codexConfigSchema_valid_config', () => {
    const parsed = codexConfigSchema.parse({ model: 'gpt-5.5', reasoning_effort: 'high' });
    expect(parsed).toEqual({
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      max_concurrent_threads_per_session: 7,
    });
  });

  it('test_codexConfigSchema_accepts_xhigh_effort', () => {
    // xhigh is advertised by the current Codex model catalog, including the
    // production default gpt-5.6-sol.
    const parsed = codexConfigSchema.parse({ reasoning_effort: 'xhigh' });
    expect(parsed.reasoning_effort).toBe('xhigh');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])(
    'test_codexConfigSchema_accepts_%s_effort',
    (effort) => {
      const parsed = codexConfigSchema.parse({ reasoning_effort: effort });
      expect(parsed.reasoning_effort).toBe(effort);
    },
  );

  it.each(['none', 'minimal'])('test_codexConfigSchema_rejects_%s_effort', (effort) => {
    const result = codexConfigSchema.safeParse({ reasoning_effort: effort });
    expect(result.success).toBe(false);
  });

  it('test_codexConfigSchema_rejects_claude_key', () => {
    const result = codexConfigSchema.safeParse({ effort: 'high' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg.toLowerCase()).toMatch(/effort|unrecognized/);
    }
  });

  it('test_codexConfigSchema_rejects_empty_model', () => {
    const result = codexConfigSchema.safeParse({ model: '' });
    expect(result.success).toBe(false);
  });

  it('test_codexConfigSchema_empty_object_defaults_to_xhigh', () => {
    // gpt-5.6-sol (our default model) supports xhigh — default to the deepest
    // tier that doesn't require an extra opt-in. Operators dial down via
    // container.json when cost/latency matter more than reasoning depth.
    const parsed = codexConfigSchema.parse({});
    expect(parsed).toEqual({ reasoning_effort: 'xhigh', max_concurrent_threads_per_session: 7 });
  });

  it('test_codexConfigSchema_explicit_low_overrides_default', () => {
    const parsed = codexConfigSchema.parse({ reasoning_effort: 'low' });
    expect(parsed).toEqual({ reasoning_effort: 'low', max_concurrent_threads_per_session: 7 });
  });

  it('test_codexConfigSchema_registered_after_barrel_import', () => {
    const schema = getProviderConfigSchema('codex');
    expect(schema).toBeDefined();
    const parsed = schema!.parse({ reasoning_effort: 'medium' });
    expect(parsed).toEqual({ reasoning_effort: 'medium', max_concurrent_threads_per_session: 7 });
  });

  it('test_validateProviderConfig_codex_rejects_invalid_effort', () => {
    const result = validateProviderConfig('codex', { reasoning_effort: 'extreme' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe('string');
  });

  it('test_codexConfigSchema_validates_native_thread_cap', () => {
    expect(codexConfigSchema.parse({ max_concurrent_threads_per_session: 5 }).max_concurrent_threads_per_session).toBe(
      5,
    );
    expect(codexConfigSchema.safeParse({ max_concurrent_threads_per_session: 0 }).success).toBe(false);
    expect(codexConfigSchema.safeParse({ max_concurrent_threads_per_session: 2.5 }).success).toBe(false);
  });
});

describe('Codex subagent lifecycle instructions', () => {
  it('states both the enforced worker budget and mandatory close behavior', () => {
    const instructions = buildCodexSubagentLifecycleInstructions(7);
    expect(instructions).toContain('one coordinator plus up to 6 subagents');
    expect(instructions).toContain('call `close_agent`');
    expect(instructions).toContain('Waiting for completion is not cleanup');
    expect(instructions).toContain('including failure and cancellation paths');
  });
});

describe('CodexProvider sticky config + override propagation', () => {
  it('test_stickyConfig_reasoning_effort_emitted_as_override', () => {
    const overrides = createCodexConfigOverrides({ reasoning_effort: 'high' });
    expect(overrides).toContain('model_reasoning_effort="high"');
  });

  it('test_features_goals_always_enabled_for_all_codex_agents', () => {
    // `features.goals=true` is always-on for every Codex container agent,
    // same shape as `features.use_linux_sandbox_bwrap=false`. Both must be
    // present regardless of sticky config (or its absence).
    const withSticky = createCodexConfigOverrides({ reasoning_effort: 'xhigh' });
    expect(withSticky).toContain('features.goals=true');
    expect(withSticky).toContain('features.use_linux_sandbox_bwrap=false');

    const withoutSticky = createCodexConfigOverrides();
    expect(withoutSticky).toContain('features.goals=true');
    expect(withoutSticky).toContain('features.use_linux_sandbox_bwrap=false');
  });

  it('test_stickyConfig_explicit_undefined_no_override', () => {
    // Constructing CodexProvider with an empty providerConfig schema-defaults
    // to 'high', so this case is hit only when stickyConfig is genuinely
    // undefined (not parsed through the schema).
    const overrides = createCodexConfigOverrides({});
    expect(overrides.find((o) => o.startsWith('model_reasoning_effort'))).toBeUndefined();
  });

  it('test_stickyConfig_default_xhigh_emits_override', () => {
    // CodexProvider's constructor parses providerConfig through the schema,
    // which defaults reasoning_effort to 'xhigh' for gpt-5.6-sol (the default
    // model). This covers the production path: every codex agent gets xhigh
    // effort unless explicitly overridden in container.json.
    const p = new CodexProvider();
    const sticky = (p as unknown as {
      stickyConfig: { reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' };
    }).stickyConfig;
    expect(sticky.reasoning_effort).toBe('xhigh');
    const overrides = createCodexConfigOverrides(sticky);
    expect(overrides).toContain('model_reasoning_effort="xhigh"');
  });

  it('test_stickyConfig_model_overrides_default_and_env', () => {
    // sticky model wins over both env and built-in default.
    const p = new CodexProvider({
      providerConfig: { model: 'gpt-5.5-pro' },
      env: { CODEX_MODEL: 'gpt-5.4-mini' },
    });
    expect((p as unknown as { model: string }).model).toBe('gpt-5.5-pro');
  });

  it('test_env_model_overrides_default_when_no_sticky', () => {
    const p = new CodexProvider({ env: { CODEX_MODEL: 'gpt-5.4-mini' } });
    expect((p as unknown as { model: string }).model).toBe('gpt-5.4-mini');
  });

  it('test_default_model_is_gpt_5_6_sol_when_no_sticky_or_env', () => {
    const p = new CodexProvider();
    expect((p as unknown as { model: string }).model).toBe('gpt-5.6-sol');
  });

  it('test_constructor_rejects_invalid_provider_config', () => {
    // R8: defensive re-parse must throw on hand-edited junk in container.json.
    expect(() => new CodexProvider({ providerConfig: { reasoning_effort: 'extreme' } })).toThrow();
  });
});
