/**
 * Tests for the container-local CODEX_HOME merger.
 *
 * Most coverage targets the pure merge helpers (no filesystem) so the tests
 * run identically on host and inside the container. A small filesystem-
 * integration block runs only inside the container, where /home/node is
 * writable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';

import {
  buildMergedConfigForTest,
  parseHostMcpServersForTest,
  renderMcpServerForTest,
  setupCodexRuntime,
  stripExistingMcpServersForTest,
} from './codex-companion-setup.js';

describe('renderMcpServer', () => {
  it('emits stdio servers with command + args + env', () => {
    const lines = renderMcpServerForTest('nanoclaw', {
      type: 'stdio',
      command: 'bun',
      args: ['run', '/app/mcp.ts'],
      env: { FOO: 'bar' },
    });
    expect(lines).toEqual([
      '[mcp_servers.nanoclaw]',
      'type = "stdio"',
      'command = "bun"',
      'args = ["run", "/app/mcp.ts"]',
      '[mcp_servers.nanoclaw.env]',
      'FOO = "bar"',
    ]);
  });

  it('omits args+env when empty', () => {
    const lines = renderMcpServerForTest('m', {
      type: 'stdio',
      command: 'x',
      args: [],
      env: {},
    });
    expect(lines).toEqual(['[mcp_servers.m]', 'type = "stdio"', 'command = "x"']);
  });

  it('emits native Codex HTTP servers with url + http_headers, no command/args', () => {
    const lines = renderMcpServerForTest('deepwiki', {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer placeholder', 'X-Tenant': 'demo' },
    });
    expect(lines).toEqual([
      '[mcp_servers.deepwiki]',
      'url = "https://example.com/mcp"',
      'http_headers = { "Authorization" = "Bearer placeholder", "X-Tenant" = "demo" }',
    ]);
  });

  it('rejects deprecated SSE servers', () => {
    expect(() => renderMcpServerForTest('legacy', { type: 'sse', url: 'https://example.com/sse' })).toThrow(
      /deprecated SSE transport/,
    );
  });

  it('escapes quotes and backslashes in strings', () => {
    const lines = renderMcpServerForTest('q', {
      type: 'stdio',
      command: 'echo "hi"\\there',
      args: [],
      env: {},
    });
    expect(lines).toContain('command = "echo \\"hi\\"\\\\there"');
  });
});

describe('stripExistingMcpServers', () => {
  it('removes [mcp_servers.X] blocks but keeps other tables and top-level keys', () => {
    const input = [
      'model = "gpt-5.5"',
      'effort = "high"',
      '',
      '[mcp_servers.exa]',
      'type = "http"',
      'url = "https://exa.example.com"',
      'http_headers = { "Authorization" = "Bearer placeholder" }',
      '',
      '[mcp_servers.gitnexus]',
      'type = "stdio"',
      'command = "npx"',
      'args = ["-y", "gitnexus", "mcp"]',
      '',
      '[mcp_servers.gitnexus.env]',
      'KEY = "value"',
      '',
      '[projects."/home/foo"]',
      'trust_level = "trusted"',
      '',
      '[features]',
      'codex_hooks = true',
    ].join('\n');

    const stripped = stripExistingMcpServersForTest(input);
    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).toContain('effort = "high"');
    expect(stripped).toContain('[projects."/home/foo"]');
    expect(stripped).toContain('trust_level = "trusted"');
    expect(stripped).toContain('[features]');
    expect(stripped).toContain('codex_hooks = true');
    expect(stripped).not.toContain('[mcp_servers.exa]');
    expect(stripped).not.toContain('[mcp_servers.gitnexus]');
    expect(stripped).not.toContain('[mcp_servers.gitnexus.env]');
    expect(stripped).not.toContain('url = "https://exa.example.com"');
  });

  it('passes through TOML with no mcp_servers tables', () => {
    const input = 'model = "x"\n[features]\nfoo = true\n';
    expect(stripExistingMcpServersForTest(input)).toBe(input);
  });

  it('handles empty input', () => {
    expect(stripExistingMcpServersForTest('')).toBe('');
  });
});

describe('buildMergedConfig', () => {
  it('union of host base + container MCP servers (both preserved)', () => {
    const hostConfig = [
      'model = "gpt-5.5"',
      '',
      '[mcp_servers.exa]',
      'type = "http"',
      'url = "https://exa"',
      '',
      '[mcp_servers.gitnexus]',
      'type = "stdio"',
      'command = "npx"',
      'args = ["-y", "gitnexus", "mcp"]',
      '',
      '[projects."/home/x"]',
      'trust_level = "trusted"',
    ].join('\n');

    const merged = buildMergedConfigForTest(hostConfig, {
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/app/mcp.ts'], env: {} },
      deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
    });

    expect(merged).toContain('model = "gpt-5.5"');
    expect(merged).toContain('[projects."/home/x"]');
    // Host MCPs are preserved (re-emitted in the union)
    expect(merged).toContain('[mcp_servers.exa]');
    expect(merged).toContain('url = "https://exa"');
    expect(merged).toContain('[mcp_servers.gitnexus]');
    expect(merged).toContain('args = ["-y", "gitnexus", "mcp"]');
    // Container MCPs added
    expect(merged).toContain('[mcp_servers.nanoclaw]');
    expect(merged).toContain('command = "bun"');
    expect(merged).toContain('[mcp_servers.deepwiki]');
    expect(merged).toContain('url = "https://mcp.deepwiki.com/mcp"');
    // No duplicate table headers for a given name
    expect((merged.match(/\[mcp_servers\.exa\]/g) ?? []).length).toBe(1);
    expect((merged.match(/\[mcp_servers\.gitnexus\]/g) ?? []).length).toBe(1);
    expect((merged.match(/\[mcp_servers\.nanoclaw\]/g) ?? []).length).toBe(1);
  });

  it('runtime entries override host entries on name collision', () => {
    const hostConfig = [
      '[mcp_servers.foo]',
      'type = "http"',
      'url = "https://old-host-url"',
    ].join('\n');

    const merged = buildMergedConfigForTest(hostConfig, {
      foo: { type: 'stdio', command: 'bun', args: ['run', '/new.ts'], env: {} },
    });

    expect(merged).not.toContain('https://old-host-url');
    expect(merged).toContain('command = "bun"');
    expect(merged).toContain('args = ["run", "/new.ts"]');
    expect((merged.match(/\[mcp_servers\.foo\]/g) ?? []).length).toBe(1);
  });

  it('handles empty host config', () => {
    const merged = buildMergedConfigForTest('', {
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/x.ts'], env: {} },
    });
    expect(merged).toContain('[mcp_servers.nanoclaw]');
  });

  it('handles no container servers (host MCPs preserved)', () => {
    const hostConfig = 'model = "x"\n\n[mcp_servers.foo]\ntype = "http"\nurl = "u"\n';
    const merged = buildMergedConfigForTest(hostConfig, {});
    expect(merged).toContain('model = "x"');
    expect(merged).toContain('[mcp_servers.foo]');
    expect(merged).toContain('url = "u"');
  });
});

describe('parseHostMcpServers', () => {
  it('parses stdio + http + env sub-table', () => {
    const toml = [
      '[mcp_servers.gitnexus]',
      'type = "stdio"',
      'command = "npx"',
      'args = ["-y", "gitnexus", "mcp"]',
      '',
      '[mcp_servers.exa]',
      'type = "http"',
      'url = "https://exa.example.com"',
      'http_headers = { "Authorization" = "Bearer placeholder" }',
      '',
      '[mcp_servers.with_env]',
      'type = "stdio"',
      'command = "bun"',
      'args = ["x"]',
      '',
      '[mcp_servers.with_env.env]',
      'KEY = "value"',
      'OTHER = "also"',
    ].join('\n');

    const parsed = parseHostMcpServersForTest(toml);
    expect(parsed.gitnexus).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'gitnexus', 'mcp'],
      env: {},
    });
    expect(parsed.exa).toEqual({
      type: 'http',
      url: 'https://exa.example.com',
      headers: { Authorization: 'Bearer placeholder' },
    });
    expect(parsed.with_env).toEqual({
      type: 'stdio',
      command: 'bun',
      args: ['x'],
      env: { KEY: 'value', OTHER: 'also' },
    });
  });

  it('returns empty for TOML with no mcp_servers tables', () => {
    expect(parseHostMcpServersForTest('model = "x"\n[features]\nfoo = true\n')).toEqual({});
  });

  it('rejects deprecated SSE host MCP entries', () => {
    const toml = ['[mcp_servers.legacy]', 'type = "sse"', 'url = "https://example.com/sse"'].join('\n');
    expect(() => parseHostMcpServersForTest(toml)).toThrow(/deprecated SSE transport/);
  });
});

// ── Filesystem integration ─────────────────────────────────────────────────
// Only runs inside the container where /home/node is writable. Skipped on
// host so `bun test` passes pre-commit without root.

const HOST_CODEX_DIR = '/home/node/.codex';
const RUNTIME_CODEX_DIR = '/home/node/.codex-runtime';

const CAN_RUN_FS = (() => {
  try {
    fs.accessSync('/home/node', fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
})();

(CAN_RUN_FS ? describe : describe.skip)('setupCodexRuntime (filesystem)', () => {
  let savedHostExists = false;
  let savedHostAuth: string | null = null;
  let savedHostConfig: string | null = null;
  let savedRuntimeExists = false;

  beforeEach(() => {
    savedHostExists = fs.existsSync(HOST_CODEX_DIR);
    if (savedHostExists) {
      const authPath = path.join(HOST_CODEX_DIR, 'auth.json');
      const cfgPath = path.join(HOST_CODEX_DIR, 'config.toml');
      if (fs.existsSync(authPath)) savedHostAuth = fs.readFileSync(authPath, 'utf-8');
      if (fs.existsSync(cfgPath)) savedHostConfig = fs.readFileSync(cfgPath, 'utf-8');
    }
    savedRuntimeExists = fs.existsSync(RUNTIME_CODEX_DIR);
    fs.mkdirSync(HOST_CODEX_DIR, { recursive: true });
  });

  afterEach(() => {
    if (!savedRuntimeExists) {
      try { fs.rmSync(RUNTIME_CODEX_DIR, { recursive: true, force: true }); } catch { /* noop */ }
    }
    if (!savedHostExists) {
      try { fs.rmSync(HOST_CODEX_DIR, { recursive: true, force: true }); } catch { /* noop */ }
    } else {
      if (savedHostAuth !== null) fs.writeFileSync(path.join(HOST_CODEX_DIR, 'auth.json'), savedHostAuth);
      if (savedHostConfig !== null) fs.writeFileSync(path.join(HOST_CODEX_DIR, 'config.toml'), savedHostConfig);
    }
  });

  it('returns null when host auth is missing', () => {
    const auth = path.join(HOST_CODEX_DIR, 'auth.json');
    if (fs.existsSync(auth)) fs.unlinkSync(auth);
    const result = setupCodexRuntime({});
    expect(result).toBe(null);
  });

  it('symlinks auth.json to host', () => {
    fs.writeFileSync(path.join(HOST_CODEX_DIR, 'auth.json'), '{}');
    const result = setupCodexRuntime({});
    expect(result).toBe(RUNTIME_CODEX_DIR);
    const runtimeAuth = path.join(RUNTIME_CODEX_DIR, 'auth.json');
    expect(fs.lstatSync(runtimeAuth).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(runtimeAuth)).toBe(path.join(HOST_CODEX_DIR, 'auth.json'));
  });

  it('writes merged config.toml with container MCP servers', () => {
    fs.writeFileSync(path.join(HOST_CODEX_DIR, 'auth.json'), '{}');
    fs.writeFileSync(
      path.join(HOST_CODEX_DIR, 'config.toml'),
      'model = "gpt-5.5"\n[mcp_servers.exa]\ntype = "http"\nurl = "https://exa"\n',
    );
    setupCodexRuntime({
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/app/mcp.ts'], env: {} },
    });
    const merged = fs.readFileSync(path.join(RUNTIME_CODEX_DIR, 'config.toml'), 'utf-8');
    expect(merged).toContain('model = "gpt-5.5"');
    expect(merged).not.toContain('[mcp_servers.exa]');
    expect(merged).toContain('[mcp_servers.nanoclaw]');
  });
});
