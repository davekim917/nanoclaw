import { describe, it, expect, beforeEach } from 'bun:test';
import { z } from 'zod';

// We need fresh module state for each test — use dynamic imports with cache busting
// to get a fresh registry. Instead, we test using the exported functions directly
// and rely on unique provider names per test to avoid cross-test collisions.
import {
  registerProviderConfigSchema,
  getProviderConfigSchema,
  validateProviderConfig,
} from './provider-registry.js';

// Use unique names per test to avoid collisions since the registry is module-global.
let counter = 0;
function uniqueName(): string {
  return `test-provider-${counter++}`;
}

describe('registerProviderConfigSchema', () => {
  it('test_registerProviderConfigSchema_duplicate_throws: throws on duplicate registration', () => {
    const name = uniqueName();
    const schema = z.strictObject({ x: z.string().optional() });
    registerProviderConfigSchema(name, schema);
    expect(() => registerProviderConfigSchema(name, schema)).toThrow(/already registered/);
  });
});

describe('getProviderConfigSchema', () => {
  it('test_getProviderConfigSchema_unregistered_returns_undefined: returns undefined for unknown provider', () => {
    expect(getProviderConfigSchema('nonexistent-provider-xyz')).toBeUndefined();
  });
});

describe('validateProviderConfig', () => {
  it('test_validateProviderConfig_unknown_provider_empty_input_ok: empty input passes when no schema', () => {
    const result = validateProviderConfig('foo-unknown', {});
    expect(result).toEqual({ ok: true, data: {} });
  });

  it('test_validateProviderConfig_unknown_provider_nonempty_input_fails: non-empty input fails with unknown-key error', () => {
    const result = validateProviderConfig('foo-unknown-2', { model: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toMatch(/unknown|unrecognized/);
    }
  });

  it('test_validateProviderConfig_undefined_input_treated_as_empty: undefined treated as empty', () => {
    const result = validateProviderConfig('foo-undefined', undefined);
    expect(result).toEqual({ ok: true, data: {} });
  });

  it('test_validateProviderConfig_registered_schema_bad_enum: registered schema rejects bad enum value', () => {
    const name = uniqueName();
    registerProviderConfigSchema(name, z.strictObject({ kind: z.enum(['a', 'b']).optional() }));
    const result = validateProviderConfig(name, { kind: 'c' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Error should mention the key path or value
      expect(result.error).toMatch(/kind|c|enum|invalid/i);
    }
  });
});
