import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });
});

// ── A4 tests: loadConfig providerConfig plumbing ──

describe('loadConfig providerConfig', () => {
  // We test config.ts by mocking fs and resetting the singleton between tests.
  // Import config module functions directly (not mocked).

  it('test_loadConfig_missing_providerConfig_defaults_empty', async () => {
    // Mock fs for this test
    mock.module('fs', () => ({
      default: {
        readFileSync: (_path: string) => JSON.stringify({ provider: 'claude' }),
        existsSync: () => false,
        readdirSync: () => [],
        statSync: () => ({ isDirectory: () => false }),
        mkdirSync: () => {},
        writeFileSync: () => {},
      },
      readFileSync: (_path: string) => JSON.stringify({ provider: 'claude' }),
      existsSync: () => false,
    }));

    const { loadConfig, _resetConfig } = await import('../config.js');
    _resetConfig();
    const result = loadConfig();
    expect(result.providerConfig).toEqual({});
  });

  it('test_loadConfig_populated_providerConfig_passthrough', async () => {
    mock.module('fs', () => ({
      default: {
        readFileSync: (_path: string) =>
          JSON.stringify({ provider: 'claude', providerConfig: { model: 'claude-opus-4-7', effort: 'high' } }),
        existsSync: () => false,
        readdirSync: () => [],
        statSync: () => ({ isDirectory: () => false }),
        mkdirSync: () => {},
        writeFileSync: () => {},
      },
      readFileSync: (_path: string) =>
        JSON.stringify({ provider: 'claude', providerConfig: { model: 'claude-opus-4-7', effort: 'high' } }),
      existsSync: () => false,
    }));

    const { loadConfig, _resetConfig } = await import('../config.js');
    _resetConfig();
    const result = loadConfig();
    expect(result.providerConfig).toEqual({ model: 'claude-opus-4-7', effort: 'high' });
  });

  it('test_factory_propagates_providerConfig_to_claude', () => {
    // createProvider('claude', { providerConfig: { model: 'claude-opus-4-7' } })
    // should return a ClaudeProvider with stickyConfig.model set.
    // We verify this by constructing the provider and checking it's a ClaudeProvider instance
    // (integration with A3's stickyConfig behavior — the sticky config is stored in the
    // private stickyConfig field, visible via query behavior tested in claude.configSchema.test.ts).
    const provider = createProvider('claude', { providerConfig: { model: 'claude-opus-4-7' } });
    expect(provider).toBeInstanceOf(ClaudeProvider);
    // Verify providerConfig doesn't throw on valid config (R8 — constructor re-parses)
    // If stickyConfig parse fails, constructor would have thrown above.
    // The model propagation into query() is tested in claude.configSchema.test.ts.
  });
});
