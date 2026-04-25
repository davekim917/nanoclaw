import { describe, expect, it } from 'bun:test';

import { createCodexConfigOverrides } from './codex-app-server.js';
import { CodexProvider, codexConfigSchema } from './codex.js';
import { getProviderConfigSchema, validateProviderConfig } from './provider-registry.js';

// Importing the providers barrel triggers all `registerProvider*` calls so the
// "after barrel import" assertions reflect the wired state, not module-load
// order accidents.
import './index.js';

describe('codexConfigSchema', () => {
  it('test_codexConfigSchema_valid_config', () => {
    const parsed = codexConfigSchema.parse({ model: 'gpt-5.5', reasoning_effort: 'high' });
    expect(parsed).toEqual({ model: 'gpt-5.5', reasoning_effort: 'high' });
  });

  it('test_codexConfigSchema_rejects_max_effort', () => {
    const result = codexConfigSchema.safeParse({ reasoning_effort: 'max' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join(' ');
      expect(msg).toMatch(/reasoning_effort|enum/i);
    }
  });

  it('test_codexConfigSchema_rejects_xhigh_effort', () => {
    const result = codexConfigSchema.safeParse({ reasoning_effort: 'xhigh' });
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

  it('test_codexConfigSchema_empty_object_passes', () => {
    const parsed = codexConfigSchema.parse({});
    expect(parsed).toEqual({});
  });

  it('test_codexConfigSchema_registered_after_barrel_import', () => {
    const schema = getProviderConfigSchema('codex');
    expect(schema).toBeDefined();
    // Round-trip through the registered instance to confirm it's the same
    // schema (not an unrelated default like z.strictObject({})).
    const parsed = schema!.parse({ reasoning_effort: 'medium' });
    expect(parsed).toEqual({ reasoning_effort: 'medium' });
  });

  it('test_validateProviderConfig_codex_rejects_invalid_effort', () => {
    const result = validateProviderConfig('codex', { reasoning_effort: 'extreme' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe('string');
  });
});

describe('CodexProvider sticky config + override propagation', () => {
  it('test_stickyConfig_reasoning_effort_emitted_as_override', () => {
    const overrides = createCodexConfigOverrides({ reasoning_effort: 'high' });
    expect(overrides).toContain('model_reasoning_effort="high"');
  });

  it('test_stickyConfig_no_effort_no_override', () => {
    const overrides = createCodexConfigOverrides({});
    expect(overrides.find((o) => o.startsWith('model_reasoning_effort'))).toBeUndefined();
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

  it('test_default_model_is_gpt_5_5_when_no_sticky_or_env', () => {
    const p = new CodexProvider();
    expect((p as unknown as { model: string }).model).toBe('gpt-5.5');
  });

  it('test_constructor_rejects_invalid_provider_config', () => {
    // R8: defensive re-parse must throw on hand-edited junk in container.json.
    expect(() => new CodexProvider({ providerConfig: { reasoning_effort: 'extreme' } })).toThrow();
  });
});
