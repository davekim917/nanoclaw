import { describe, expect, it } from 'bun:test';

import { createCodexConfigOverrides } from './codex-app-server.js';
import {
  buildCodexSubagentLifecycleInstructions,
  CodexProvider,
  codexConfigSchema,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  resolveQueryEffort,
  resolveQueryModel,
} from './codex.js';
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
      max_concurrent_threads_per_session: 5,
    });
  });

  it('test_codexConfigSchema_accepts_xhigh_effort', () => {
    // xhigh is advertised by the current Codex model catalog, including the
    // fleet default gpt-5.6-sol.
    const parsed = codexConfigSchema.parse({ reasoning_effort: 'xhigh' });
    expect(parsed.reasoning_effort).toBe('xhigh');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('test_codexConfigSchema_accepts_%s_effort', (effort) => {
    const parsed = codexConfigSchema.parse({ reasoning_effort: effort });
    expect(parsed.reasoning_effort).toBe(effort);
  });

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

  it('test_codexConfigSchema_empty_object_defaults_to_the_fleet_effort', () => {
    // The unpinned fleet default: `high`, matching the Claude side's Opus at
    // high (operator decision 2026-09-16; it was `xhigh` for gpt-5.6-terra).
    // The full ladder (xhigh|max|ultra) is still accepted when operators opt
    // in via container.json. Asserted against the constant, so the default
    // lives in exactly one place.
    const parsed = codexConfigSchema.parse({});
    expect(DEFAULT_CODEX_EFFORT).toBe('high');
    expect(parsed).toEqual({ reasoning_effort: DEFAULT_CODEX_EFFORT, max_concurrent_threads_per_session: 5 });
  });

  it('test_codexConfigSchema_explicit_low_overrides_default', () => {
    const parsed = codexConfigSchema.parse({ reasoning_effort: 'low' });
    expect(parsed).toEqual({ reasoning_effort: 'low', max_concurrent_threads_per_session: 5 });
  });

  it('test_codexConfigSchema_registered_after_barrel_import', () => {
    const schema = getProviderConfigSchema('codex');
    expect(schema).toBeDefined();
    const parsed = schema!.parse({ reasoning_effort: 'medium' });
    expect(parsed).toEqual({ reasoning_effort: 'medium', max_concurrent_threads_per_session: 5 });
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
    const maxConcurrentThreadsPerSession = codexConfigSchema.parse({}).max_concurrent_threads_per_session;
    expect(maxConcurrentThreadsPerSession).toBe(5);
    const instructions = buildCodexSubagentLifecycleInstructions(maxConcurrentThreadsPerSession);
    expect(instructions).toContain('up to 5 concurrent subagents, excluding the primary thread');
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
    // to 'xhigh', so this case is hit only when stickyConfig is genuinely
    // undefined (not parsed through the schema).
    const overrides = createCodexConfigOverrides({});
    expect(overrides.find((o) => o.startsWith('model_reasoning_effort'))).toBeUndefined();
  });

  it('test_stickyConfig_default_effort_emits_override', () => {
    // CodexProvider's constructor parses providerConfig through the schema,
    // which defaults reasoning_effort to the fleet default. This covers the
    // production path: every unpinned Codex agent gets that effort unless
    // explicitly overridden in container.json.
    const p = new CodexProvider();
    const sticky = (
      p as unknown as {
        stickyConfig: { reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' };
      }
    ).stickyConfig;
    expect(sticky.reasoning_effort).toBe('high');
    const overrides = createCodexConfigOverrides(sticky);
    expect(overrides).toContain('model_reasoning_effort="high"');
  });

  it('test_unpinned_codex_group_resolves_to_sol_at_high', () => {
    // The fleet default as one fact: an unpinned native Codex group — no
    // providerConfig, no CODEX_MODEL — runs gpt-6-sol at high reasoning
    // (operator decision 2026-09-16, was gpt-5.6-terra at xhigh). Asserted as
    // literals AND against the constants, so neither can move alone.
    const p = new CodexProvider();
    const cfg = (p as unknown as { stickyConfig: { reasoning_effort?: string } }).stickyConfig;
    expect((p as unknown as { model: string }).model).toBe('gpt-6-sol');
    expect(cfg.reasoning_effort).toBe('high');
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-6-sol');
    expect((p as unknown as { model: string }).model).toBe(DEFAULT_CODEX_MODEL);
  });

  it('test_a_pinned_codex_group_is_untouched_by_the_fleet_default', () => {
    // The shape of a pinned group in this install (sol at medium): the pin
    // wins over the fleet default in BOTH fields, and a pin to a different
    // model is likewise untouched. A default that rewrote a pin is not a
    // default.
    type Cfg = { stickyConfig: { reasoning_effort?: string } };
    const pinned = new CodexProvider({ providerConfig: { model: 'gpt-5.6-sol', reasoning_effort: 'medium' } });
    expect((pinned as unknown as { model: string }).model).toBe('gpt-5.6-sol');
    expect((pinned as unknown as Cfg).stickyConfig.reasoning_effort).toBe('medium');

    const other = new CodexProvider({ providerConfig: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' } });
    expect((other as unknown as { model: string }).model).toBe('gpt-6-astra');
    expect((other as unknown as Cfg).stickyConfig.reasoning_effort).toBe('xhigh');
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

  it('test_default_model_is_the_fleet_default_when_no_sticky_or_env', () => {
    const p = new CodexProvider();
    expect((p as unknown as { model: string }).model).toBe(DEFAULT_CODEX_MODEL);
  });

  it('test_constructor_rejects_invalid_provider_config', () => {
    // R8: defensive re-parse must throw on hand-edited junk in container.json.
    expect(() => new CodexProvider({ providerConfig: { reasoning_effort: 'extreme' } })).toThrow();
  });
});

describe('CodexProvider provider-fallback model/effort', () => {
  type Sticky = { model?: string; reasoning_effort?: string };
  const sticky = (p: CodexProvider): Sticky => (p as unknown as { stickyConfig: Sticky }).stickyConfig;

  it('test_fallback_model_and_effort_applied_when_providerConfig_empty', () => {
    // A claude group whose `providerFallback` declares codex spawns with an
    // EMPTY providerConfig (config.ts drops the primary's sticky config) and
    // the fallback's model/effort on options.model/options.effort. Without
    // this the container ignored the declared fallback settings and used the
    // provider default instead.
    const p = new CodexProvider({ providerConfig: {}, model: 'gpt-5.5-pro', effort: 'xhigh' });
    expect(sticky(p).model).toBe('gpt-5.5-pro');
    expect(sticky(p).reasoning_effort).toBe('xhigh');
    // Reach the actual app-server seam, not just the field. gen() computes
    // `resolveQueryModel(input.model, this.model)` -> thread.start params and
    // `createCodexConfigOverrides(resolveQueryEffort(input.effort, sticky))`
    // -> spawnCodexAppServer. With no per-turn -m/-e (the normal case for a
    // fallback spawn) both must carry the declared values through.
    expect(resolveQueryModel(undefined, (p as unknown as { model: string }).model)).toBe('gpt-5.5-pro');
    expect(createCodexConfigOverrides(resolveQueryEffort(undefined, sticky(p) as never))).toContain(
      'model_reasoning_effort="xhigh"',
    );
  });

  it('test_per_turn_flags_still_beat_the_fallback_declaration', () => {
    // The fallback sets the session default, not a floor: an explicit -m/-e
    // on the turn must still win at the same seam.
    const p = new CodexProvider({ providerConfig: {}, model: 'gpt-5.5-pro', effort: 'xhigh' });
    expect(resolveQueryModel('gpt-5.6-luna', (p as unknown as { model: string }).model)).toBe('gpt-5.6-luna');
    expect(createCodexConfigOverrides(resolveQueryEffort('low', sticky(p) as never))).toContain(
      'model_reasoning_effort="low"',
    );
  });

  it('test_fallback_effort_only_leaves_model_on_its_default', () => {
    const p = new CodexProvider({ providerConfig: {}, effort: 'low' });
    expect(sticky(p).model).toBeUndefined();
    expect(sticky(p).reasoning_effort).toBe('low');
    expect((p as unknown as { model: string }).model).toBe(DEFAULT_CODEX_MODEL);
  });

  it('test_declared_providerConfig_still_wins_on_the_primary_path', () => {
    // Primary codex groups must be untouched: config.ts has already resolved
    // the channel/agent model+effort into providerConfig, and options carries
    // the same chain. providerConfig is authoritative.
    const p = new CodexProvider({
      providerConfig: { model: 'gpt-5.5-pro', reasoning_effort: 'medium' },
      model: 'gpt-5.4-mini',
      effort: 'ultra',
    });
    expect(sticky(p).model).toBe('gpt-5.5-pro');
    expect(sticky(p).reasoning_effort).toBe('medium');
  });

  it('test_non_codex_options_model_and_effort_are_ignored_not_fatal', () => {
    // A mis-declared providerFallback (claude model id, claude-only effort)
    // must degrade to codex's own defaults, never throw at boot — the schema
    // is strict and a throw here is a crash loop, not a bad answer.
    const p = new CodexProvider({ providerConfig: {}, model: 'claude-opus-5[1m]', effort: 'extreme' });
    expect(sticky(p).model).toBeUndefined();
    expect(sticky(p).reasoning_effort).toBe(DEFAULT_CODEX_EFFORT);
    expect((p as unknown as { model: string }).model).toBe(DEFAULT_CODEX_MODEL);
  });

  it('test_no_options_model_or_effort_keeps_schema_defaults', () => {
    const p = new CodexProvider({ providerConfig: {} });
    expect(sticky(p).model).toBeUndefined();
    expect(sticky(p).reasoning_effort).toBe(DEFAULT_CODEX_EFFORT);
  });
});
