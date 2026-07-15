import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';
import { parseRawConfig } from '../config.js';

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
  // Tests exercise parseRawConfig directly so the filesystem and module
  // singleton stay out of it. The previous mock.module('fs', ...) approach
  // leaked process-globally and clobbered codex-app-server.test.ts's
  // fs.readFileSync — bun's mock.restore() does not undo module mocks.

  it('test_loadConfig_missing_providerConfig_defaults_empty', () => {
    const result = parseRawConfig({ provider: 'claude' });
    expect(result.providerConfig).toEqual({});
  });

  it('test_loadConfig_populated_providerConfig_passthrough', () => {
    const result = parseRawConfig({
      provider: 'claude',
      providerConfig: { model: 'claude-opus-4-7', effort: 'high' },
    });
    expect(result.providerConfig).toEqual({ model: 'claude-opus-4-7', effort: 'high' });
  });

  it('test_loadConfig_preserves_stdio_and_http_mcp_transports', () => {
    const result = parseRawConfig({
      provider: 'codex',
      mcpServers: {
        local: { command: 'bun', args: ['run', '/app/mcp.ts'], env: { FOO: 'bar' } },
        exa: {
          type: 'http',
          url: 'https://mcp.exa.ai/mcp',
          headers: { Authorization: 'Bearer placeholder' },
        },
      },
    });

    expect(result.mcpServers.local).toEqual({ command: 'bun', args: ['run', '/app/mcp.ts'], env: { FOO: 'bar' } });
    expect(result.mcpServers.exa).toEqual({
      type: 'http',
      url: 'https://mcp.exa.ai/mcp',
      headers: { Authorization: 'Bearer placeholder' },
    });
  });

  it('test_loadConfig_preserves_excluded_mcp_servers', () => {
    const result = parseRawConfig({
      provider: 'codex',
      excludeMcpServers: ['gitnexus', 'exa'],
    });

    expect(result.excludeMcpServers).toEqual(['gitnexus', 'exa']);
  });

  it('test_loadConfig_rejects_deprecated_sse_mcp_servers', () => {
    expect(() =>
      parseRawConfig({
        provider: 'codex',
        mcpServers: { legacy: { type: 'sse', url: 'https://example.test/sse' } },
      }),
    ).toThrow(/deprecated SSE transport/);
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
