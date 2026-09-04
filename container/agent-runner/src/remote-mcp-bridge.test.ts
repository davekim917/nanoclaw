import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { requestHeaders } from './remote-mcp-bridge.js';

/**
 * `main()` is guarded by `import.meta.main` (only runs when this file is the
 * process entry point, e.g. `bun remote-mcp-bridge.ts <url>`), so importing
 * it here to test `requestHeaders` does not open a network connection.
 */
describe('requestHeaders', () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot.REMOTE_MCP_HEADERS = process.env.REMOTE_MCP_HEADERS;
    delete process.env.REMOTE_MCP_HEADERS;
  });

  afterEach(() => {
    if (snapshot.REMOTE_MCP_HEADERS === undefined) delete process.env.REMOTE_MCP_HEADERS;
    else process.env.REMOTE_MCP_HEADERS = snapshot.REMOTE_MCP_HEADERS;
  });

  it('returns undefined when REMOTE_MCP_HEADERS is unset', () => {
    expect(requestHeaders()).toBeUndefined();
  });

  it('forwards the full header map, not just Authorization', () => {
    // Round 5 finding: codex.ts:1017-1024 used to extract only Authorization
    // into a single env var; a server declared with X-Api-Version or a
    // custom OneCLI-managed placeholder header had every other header
    // silently dropped by this bridge.
    process.env.REMOTE_MCP_HEADERS = JSON.stringify({
      Authorization: 'Bearer onecli-managed',
      'X-Api-Version': '2024-01-01',
      'X-Custom': 'onecli-managed',
    });
    expect(requestHeaders()).toEqual({
      Authorization: 'Bearer onecli-managed',
      'X-Api-Version': '2024-01-01',
      'X-Custom': 'onecli-managed',
    });
  });

  it('returns undefined for an empty header object', () => {
    process.env.REMOTE_MCP_HEADERS = '{}';
    expect(requestHeaders()).toBeUndefined();
  });

  it('throws on malformed JSON rather than silently dropping headers', () => {
    process.env.REMOTE_MCP_HEADERS = '{not-json';
    expect(() => requestHeaders()).toThrow(/not valid JSON/);
  });

  it('throws when REMOTE_MCP_HEADERS is not a JSON object', () => {
    process.env.REMOTE_MCP_HEADERS = '["a", "b"]';
    expect(() => requestHeaders()).toThrow(/must be a JSON object/);
    process.env.REMOTE_MCP_HEADERS = '"just a string"';
    expect(() => requestHeaders()).toThrow(/must be a JSON object/);
  });
});
