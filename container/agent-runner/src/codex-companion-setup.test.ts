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
import os from 'os';
import path from 'path';

import {
  buildMergedConfigForTest,
  parseHostMcpServersForTest,
  planCodexPluginRegistration,
  renderMcpServerForTest,
  setupCodexRuntime,
  stripExistingMcpServersForTest,
  stripPluginsAndMarketplacesForTest,
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
    // Unrelated host MCPs are preserved (re-emitted in the union).
    expect(merged).toContain('[mcp_servers.exa]');
    expect(merged).toContain('url = "https://exa"');
    expect(merged).not.toContain('[mcp_servers.gitnexus]');
    expect(merged).not.toContain('args = ["-y", "gitnexus", "mcp"]');
    // Container MCPs added
    expect(merged).toContain('[mcp_servers.nanoclaw]');
    expect(merged).toContain('command = "bun"');
    expect(merged).toContain('[mcp_servers.deepwiki]');
    expect(merged).toContain('url = "https://mcp.deepwiki.com/mcp"');
    // No duplicate table headers for a given name
    expect((merged.match(/\[mcp_servers\.exa\]/g) ?? []).length).toBe(1);
    expect((merged.match(/\[mcp_servers\.gitnexus\]/g) ?? []).length).toBe(0);
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

  it('test_codex_companion_does_not_link_host_gitnexus_instructions', () => {
    const hostConfig = [
      'model = "gpt-5.5"',
      'approval_policy = "on-request"',
      '',
      '[mcp_servers.context7]',
      'type = "http"',
      'url = "https://context7.example.com/mcp"',
      '',
      '[mcp_servers.gitnexus]',
      'command = "npx"',
      'args = ["-y", "gitnexus", "mcp"]',
      '',
      '[plugins.humanizer]',
      'enabled = true',
      '',
      '[plugins.gitnexus]',
      'enabled = true',
      'cache_path = "/home/node/.codex/plugins/cache/gitnexus/1.0.0"',
      '',
      '[plugin_marketplaces.gitnexus]',
      'source = "/home/ubuntu/plugins/gitnexus"',
    ].join('\n');
    const merged = buildMergedConfigForTest(hostConfig, {
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/app/mcp.ts'], env: {} },
      gitnexus: { type: 'stdio', command: '/pnpm/gitnexus', args: ['mcp'], env: {} },
    });

    expect(merged).not.toMatch(/gitnexus/i);
    expect(merged).toContain('model = "gpt-5.5"');
    expect(merged).toContain('approval_policy = "on-request"');
    expect(merged).toContain('[mcp_servers.context7]');
    expect(merged).toContain('[mcp_servers.nanoclaw]');
    // Containers must have zero dependency on host CLI plugin state: ALL
    // [plugins.*] / [plugin_marketplaces.*] blocks are stripped now, not just
    // gitnexus's — even a harmless-looking one like humanizer.
    expect(merged).not.toContain('[plugins.humanizer]');
    expect(merged).not.toContain('[plugins.gitnexus]');
    expect(merged).not.toContain('[plugin_marketplaces.gitnexus]');

    const source = fs.readFileSync(new URL('./codex-companion-setup.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("path.join(HOST_CODEX_DIR, 'AGENTS.md')");
    expect(source).not.toContain("path.join(RUNTIME_CODEX_DIR, 'AGENTS.md')");
    expect(source).not.toContain('symlink the host\'s behavioral rules');
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

describe('stripPluginsAndMarketplaces', () => {
  it('strips real Codex plugin/marketplace table shapes (verified against a live ~/.codex/config.toml)', () => {
    // Real Codex writes `[plugins."<entry>@<marketplace>"]` (quoted, dotted-@)
    // and `[marketplaces.<name>]` (bare) — verified against a live host
    // config.toml, not guessed.
    const toml = [
      'model = "gpt-5.5"',
      '',
      '[plugins."wix@skills"]',
      'enabled = true',
      '',
      '[plugins."humanizer@humanizer"]',
      'enabled = true',
      '',
      '[marketplaces.skills]',
      'source_type = "local"',
      'source = "/home/ubuntu/plugins/skills"',
      '',
      '[marketplaces.humanizer]',
      'source_type = "local"',
      'source = "/home/ubuntu/plugins/humanizer"',
      '',
      '[mcp_servers.exa]',
      'type = "http"',
      'url = "https://exa"',
      '',
      '[projects."/home/x"]',
      'trust_level = "trusted"',
    ].join('\n');

    const stripped = stripPluginsAndMarketplacesForTest(toml);
    expect(stripped).not.toContain('[plugins."wix@skills"]');
    expect(stripped).not.toContain('[plugins."humanizer@humanizer"]');
    expect(stripped).not.toContain('[marketplaces.skills]');
    expect(stripped).not.toContain('[marketplaces.humanizer]');
    expect(stripped).not.toContain('/home/ubuntu/plugins/skills');
    // Unrelated tables survive untouched.
    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).toContain('[mcp_servers.exa]');
    expect(stripped).toContain('url = "https://exa"');
    expect(stripped).toContain('[projects."/home/x"]');
    expect(stripped).toContain('trust_level = "trusted"');
  });

  it('strips a bare [plugins] / [marketplaces] table header with no dotted suffix', () => {
    // `model = "x"` must precede any table header — once a `[table]` header
    // is seen, subsequent key = value lines belong to THAT table in real
    // TOML, so a trailing top-level key would need its own header to close
    // the preceding block (exactly like stripExistingMcpServers/
    // stripGitNexusReentrySurfaces, which share this same block-scoping).
    const toml = ['model = "x"', '', '[plugins]', 'some_key = true', '', '[marketplaces]', 'other = false'].join(
      '\n',
    );
    const stripped = stripPluginsAndMarketplacesForTest(toml);
    expect(stripped).not.toContain('some_key');
    expect(stripped).not.toContain('other = false');
    expect(stripped).toContain('model = "x"');
  });

  it('passes through TOML with no plugins/marketplaces tables', () => {
    const toml = 'model = "x"\n[mcp_servers.foo]\ntype = "http"\nurl = "u"\n';
    expect(stripPluginsAndMarketplacesForTest(toml)).toBe(toml);
  });

  it('handles empty input', () => {
    expect(stripPluginsAndMarketplacesForTest('')).toBe('');
  });
});

describe('planCodexPluginRegistration', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-plan-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeJson(p: string, obj: unknown) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj));
  }

  it('returns an empty plan for a missing plugins root', () => {
    expect(planCodexPluginRegistration(path.join(root, 'does-not-exist'))).toEqual([]);
  });

  it('skips a non-directory entry', () => {
    fs.writeFileSync(path.join(root, 'stray-file'), 'not a plugin');
    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([{ name: 'stray-file', action: 'skip', reason: 'not-a-directory' }]);
  });

  it('skips a plugin whose .nanoclaw-plugin.json denies codex', () => {
    const dir = path.join(root, 'some-plugin');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, '.nanoclaw-plugin.json'), { denySiblings: ['codex'] });
    writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'some-plugin' });
    writeJson(path.join(dir, '.agents', 'plugins', 'marketplace.json'), { name: 'some-plugin' });

    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([{ name: 'some-plugin', action: 'skip', reason: 'denied-for-codex' }]);
  });

  it('skips a plugin with no .codex-plugin/plugin.json (not Codex-registerable)', () => {
    const dir = path.join(root, 'skill-only-plugin');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, '.agents', 'plugins', 'marketplace.json'), { name: 'skill-only-plugin' });

    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([{ name: 'skill-only-plugin', action: 'skip', reason: 'no-codex-plugin-manifest' }]);
  });

  it('skips a plugin with no .agents/plugins/marketplace.json', () => {
    const dir = path.join(root, 'no-marketplace-plugin');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'no-marketplace-plugin' });

    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([{ name: 'no-marketplace-plugin', action: 'skip', reason: 'no-marketplace-manifest' }]);
  });

  it('resolves entry name from plugin.json and marketplace name from marketplace.json — NOT the folder name', () => {
    // Reproduces the real wix-in-~/plugins/skills shape: folder is "skills",
    // but .codex-plugin/plugin.json name is "wix" and
    // .agents/plugins/marketplace.json name is "skills". `codex plugin add`
    // must be called as `wix@skills`, never `skills@skills`.
    const dir = path.join(root, 'skills');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'wix', version: '1.15.0' });
    writeJson(path.join(dir, '.agents', 'plugins', 'marketplace.json'), {
      name: 'skills',
      plugins: [{ name: 'wix', source: { source: 'local', path: './' } }],
    });

    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([
      { name: 'skills', action: 'register', entryName: 'wix', marketplaceName: 'skills', repoName: 'skills' },
    ]);
  });

  it('handles a mix of register + every skip reason across multiple entries', () => {
    fs.writeFileSync(path.join(root, 'a-stray-file'), 'x');

    const denied = path.join(root, 'denied-plugin');
    fs.mkdirSync(denied, { recursive: true });
    writeJson(path.join(denied, '.nanoclaw-plugin.json'), { denySiblings: ['codex'] });

    const registerable = path.join(root, 'taste-skill');
    fs.mkdirSync(registerable, { recursive: true });
    writeJson(path.join(registerable, '.codex-plugin', 'plugin.json'), { name: 'taste-skill' });
    writeJson(path.join(registerable, '.agents', 'plugins', 'marketplace.json'), { name: 'taste-skill' });

    const plans = planCodexPluginRegistration(root);
    const byName = new Map(plans.map((p) => [p.name, p]));
    expect(byName.get('a-stray-file')).toEqual({ name: 'a-stray-file', action: 'skip', reason: 'not-a-directory' });
    expect(byName.get('denied-plugin')).toEqual({ name: 'denied-plugin', action: 'skip', reason: 'denied-for-codex' });
    expect(byName.get('taste-skill')).toEqual({
      name: 'taste-skill',
      action: 'register',
      entryName: 'taste-skill',
      marketplaceName: 'taste-skill',
      // `repoName` is the dir `codex plugin marketplace add` targets. For a
      // single-plugin repo it equals `name`; for a monorepo sub-plugin the label
      // is `<repo>/<entry>` while repoName stays the repo root.
      repoName: 'taste-skill',
    });
    expect(plans).toHaveLength(3);
  });

  it('registers marketplace-monorepo sub-plugins (no manifest at the repo root)', () => {
    // Regression guard. role-specific-plugins / claude-plugins-official / bootstrap keep
    // their .codex-plugin manifests one level down. Planning only top-level manifests
    // silently dropped those ENTIRE repos — data-analytics (14 skills) and
    // bootstrap-workflow-agents (17) vanished from codex containers with no error.
    const repo = path.join(root, 'monorepo');
    fs.mkdirSync(path.join(repo, '.agents', 'plugins'), { recursive: true });
    writeJson(path.join(repo, '.agents', 'plugins', 'marketplace.json'), { name: 'monorepo-mkt' });
    // Checked-out sub-plugin WITH a manifest → registers.
    const sub = path.join(repo, 'plugins', 'analytics');
    fs.mkdirSync(path.join(sub, '.codex-plugin'), { recursive: true });
    writeJson(path.join(sub, '.codex-plugin', 'plugin.json'), { name: 'data-analytics' });
    // Sub-dir advertised by the marketplace but NOT checked out / no manifest → ignored,
    // which is what makes a sparse checkout register only what is actually present.
    fs.mkdirSync(path.join(repo, 'plugins', 'not-checked-out'), { recursive: true });

    const byName = new Map(planCodexPluginRegistration(root).map((p) => [p.name, p]));
    expect(byName.get('monorepo/data-analytics')).toEqual({
      name: 'monorepo/data-analytics',
      action: 'register',
      entryName: 'data-analytics',
      marketplaceName: 'monorepo-mkt',
      repoName: 'monorepo',
    });
    expect(byName.has('monorepo/not-checked-out')).toBe(false);
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
    expect(merged).toContain('[mcp_servers.exa]');
    expect(merged).toContain('[mcp_servers.nanoclaw]');
  });
});
