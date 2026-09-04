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
  buildRuntimeConfigForTest,
  planCodexPluginRegistration,
  projectCodexPluginConfigForTest,
  renderMcpServerForTest,
  setupCodexRuntime,
  stripPluginsAndMarketplacesForTest,
} from './codex-companion-setup.js';
import { parseTomlTableHeader } from './providers/codex-app-server.js';

describe('parseTomlTableHeader', () => {
  it('closes on the LAST bracket so a quoted segment may contain one', () => {
    expect(parseTomlTableHeader('[features]')).toBe('features');
    expect(parseTomlTableHeader('  [mcp_servers.nanoclaw.env]  ')).toBe('mcp_servers.nanoclaw.env');
    expect(parseTomlTableHeader('[plugins."github@openai-curated"]')).toBe('plugins."github@openai-curated"');
    expect(parseTomlTableHeader('[mcp_servers."a]b"]')).toBe('mcp_servers."a]b"');
    expect(parseTomlTableHeader('key = "value"')).toBeNull();
    expect(parseTomlTableHeader('')).toBeNull();
  });
});

describe('splitPluginsAndMarketplaces', () => {
  it('strips a plugin table whose quoted name contains a bracket', () => {
    // Containers must carry ZERO host CLI plugin state. A header the scanner
    // fails to recognize leaks the table AND, because the in-block flag goes
    // stale, silently swallows whatever base config follows it.
    const stripped = stripPluginsAndMarketplacesForTest(
      ['[plugins."we]ird@mkt"]', 'enabled = true', '', '[features]', 'hooks = true', ''].join('\n'),
    );
    expect(stripped).not.toContain('we]ird@mkt');
    expect(stripped).not.toContain('enabled = true');
    expect(stripped).toContain('[features]');
    expect(stripped).toContain('hooks = true');
  });
});

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

  it('quotes non-bare names/keys and emits cwd above the env header', () => {
    // Second Codex config.toml writer in the tree, same blast radius as
    // writeCodexMcpConfigToml: one malformed table drops every MCP server.
    const lines = renderMcpServerForTest('acme.tools', {
      type: 'stdio',
      command: 'bun',
      args: ['run', '/app/mcp.ts'],
      env: { 'x.y': 'bar' },
      cwd: '/workspace/plugin-data/acme',
    });
    expect(lines).toEqual([
      '[mcp_servers."acme.tools"]',
      'type = "stdio"',
      'command = "bun"',
      'cwd = "/workspace/plugin-data/acme"',
      'args = ["run", "/app/mcp.ts"]',
      '[mcp_servers."acme.tools".env]',
      '"x.y" = "bar"',
    ]);
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

describe('buildRuntimeConfig', () => {
  it('is generated base + runtime MCP servers — host config contributes nothing by construction', () => {
    const config = buildRuntimeConfigForTest({
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/app/mcp.ts'], env: {} },
      deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
    });

    // Generated container base, load-bearing settings present.
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).toContain('approval_policy = "on-request"');
    expect(config).toContain('[features]');
    expect(config).toContain('hooks = true');
    expect(config).toContain('[features.multi_agent_v2]');
    expect(config).toContain('[projects."/workspace/agent"]');
    // Runtime MCP servers appended.
    expect(config).toContain('[mcp_servers.nanoclaw]');
    expect(config).toContain('command = "bun"');
    expect(config).toContain('[mcp_servers.deepwiki]');
    expect(config).toContain('url = "https://mcp.deepwiki.com/mcp"');
    // No model pin or personality can exist — the base is a constant.
    expect(config).not.toContain('model =');
    expect(config).not.toContain('personality');
  });

  it('drops a container-retired gitnexus entry even if wired', () => {
    const config = buildRuntimeConfigForTest({
      gitnexus: { type: 'stdio', command: '/pnpm/gitnexus', args: ['mcp'], env: {} },
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/app/mcp.ts'], env: {} },
    });
    expect(config).not.toMatch(/gitnexus/i);
    expect(config).toContain('[mcp_servers.nanoclaw]');
  });

  it('handles zero runtime servers', () => {
    const config = buildRuntimeConfigForTest({});
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).not.toContain('[mcp_servers.');
  });

  it('test_codex_companion_never_reads_host_config_or_agents', () => {
    const source = fs.readFileSync(new URL('./codex-companion-setup.ts', import.meta.url), 'utf8');
    // Regression pins from past incidents, plus the decoupling contract:
    expect(source).not.toContain("path.join(HOST_CODEX_DIR, 'AGENTS.md')");
    expect(source).not.toContain("path.join(RUNTIME_CODEX_DIR, 'AGENTS.md')");
    expect(source).not.toContain("symlink the host's behavioral rules");
    // Peer runtime must not read the host's agents/ dir or merge host config.
    // (setupCodexPrimaryRuntime legitimately reads /home/node/.codex/config.toml
    // — in provider=codex mode that is the session-local GENERATED config.)
    expect(source).not.toContain("path.join(HOST_CODEX_DIR, 'agents')");
    expect(source).not.toContain('parseHostMcpServers');
    expect(source).not.toContain('buildMergedConfig');
  });

  it('installs the in-tree hook chain into the peer-mode CODEX_HOME', () => {
    const source = fs.readFileSync(new URL('./codex-companion-setup.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/writeCodexHooksJson\(\{\s*codexHome:\s*RUNTIME_CODEX_DIR\s*\}\)/);
  });

  it('setupCodexRuntime fails closed on codex, not on the container', () => {
    // A `return null` on a hard failure is a guard BYPASS, not a degrade: the
    // caller only sets CODEX_HOME on a non-null return, so peer `codex exec`
    // would fall back to the host-mounted /home/node/.codex — authenticated and
    // with no PreToolUse guard chain. Hard paths must hand back the nonexistent
    // sentinel instead, which codex refuses to start on. Throwing would also
    // close the guard but takes the whole container down over an optional peer
    // feature — under disk pressure that turns a degrade into a crash-loop.
    const source = fs.readFileSync(new URL('./codex-companion-setup.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export function setupCodexRuntime');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\nfunction replaceWithDirectorySymlink', start));

    // The ONLY null return is the benign missing-auth case.
    expect(body.match(/return null/g) ?? []).toHaveLength(1);
    expect(body).toMatch(/Host codex auth not mounted[\s\S]*?return null/);
    // mkdir, auth symlink, config.toml write, hooks.json write — all four
    // hand the sentinel back to the caller.
    expect(body.match(/return failClosed\(/g) ?? []).toHaveLength(4);
    expect(body).not.toMatch(/\bthrow new\b/);

    // The sentinel must be a nonexistent path (codex hard-errors on it), and
    // failClosed must RETURN it rather than throw. Slice the helper's own body
    // only — trailing docs are prose and may legitimately say "throw".
    expect(source).toMatch(/const FAILED_CODEX_HOME = '\/nonexistent\/[^']+';/);
    const helperStart = source.indexOf('function failClosed(');
    const helper = source.slice(helperStart, source.indexOf('\n}\n', helperStart));
    expect(helper).toMatch(/^function failClosed\(what: string, err: unknown\): string \{/);
    expect(helper).toContain('return FAILED_CODEX_HOME;');
    expect(helper).not.toMatch(/\bthrow new\b/);
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
    const toml = ['model = "x"', '', '[plugins]', 'some_key = true', '', '[marketplaces]', 'other = false'].join('\n');
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

  it('projects one container-owned registration into an OAuth fallback config', () => {
    const primary = [
      'model = "gpt-5.6-sol"',
      '',
      '[plugins."bootstrap-workflow-agents@davekim917-bootstrap"]',
      'enabled = true',
      '',
      '[marketplaces.davekim917-bootstrap]',
      'source_type = "local"',
      'source = "/workspace/plugins/bootstrap"',
      '',
      '[mcp_servers.nanoclaw]',
      'command = "bun"',
    ].join('\n');
    const fallback = [
      'model = "gpt-5.6-sol"',
      '',
      '[plugins."stale@host"]',
      'enabled = true',
      '',
      '[marketplaces.host]',
      'source = "/home/ubuntu/.codex/plugins"',
      '',
      '[features]',
      'codex_hooks = true',
    ].join('\n');

    const projected = projectCodexPluginConfigForTest(primary, fallback);
    expect(projected).toContain('[plugins."bootstrap-workflow-agents@davekim917-bootstrap"]');
    expect(projected).toContain('[marketplaces.davekim917-bootstrap]');
    expect(projected).not.toContain('[plugins."stale@host"]');
    expect(projected).not.toContain('/home/ubuntu/.codex/plugins');
    expect(projected).toContain('[features]');
    expect(projected).toContain('codex_hooks = true');
    expect(projected).not.toContain('[mcp_servers.nanoclaw]');
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
      try {
        fs.rmSync(RUNTIME_CODEX_DIR, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    if (!savedHostExists) {
      try {
        fs.rmSync(HOST_CODEX_DIR, { recursive: true, force: true });
      } catch {
        /* noop */
      }
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

  it('writes generated config.toml with container MCP servers; host config is ignored', () => {
    fs.writeFileSync(path.join(HOST_CODEX_DIR, 'auth.json'), '{}');
    fs.writeFileSync(
      path.join(HOST_CODEX_DIR, 'config.toml'),
      'model = "gpt-5.5"\npersonality = "pragmatic"\n[mcp_servers.exa]\ntype = "http"\nurl = "https://exa"\n',
    );
    setupCodexRuntime({
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/app/mcp.ts'], env: {} },
    });
    const written = fs.readFileSync(path.join(RUNTIME_CODEX_DIR, 'config.toml'), 'utf-8');
    expect(written).not.toContain('gpt-5.5');
    expect(written).not.toContain('personality');
    expect(written).not.toContain('[mcp_servers.exa]');
    expect(written).toContain('sandbox_mode = "workspace-write"');
    expect(written).toContain('[mcp_servers.nanoclaw]');
    const hooks = JSON.parse(fs.readFileSync(path.join(RUNTIME_CODEX_DIR, 'hooks.json'), 'utf-8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe('bun /app/src/codex-hooks/cli.ts PreToolUse');
  });
});
