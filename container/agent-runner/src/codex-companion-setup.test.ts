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
  readCodexConfigToml,
  renderMcpServerForTest,
  setupCodexRuntime,
  stripPluginsAndMarketplacesForTest,
  verifyCodexHookTrust,
  writeCodexHooksAndTrust,
} from './codex-companion-setup.js';
import { type AppServer, buildCodexHooksJson, parseTomlTableHeader } from './providers/codex-app-server.js';
import { codexHookEventKey, collectCodexHookTrustEntries, isCodexHookEvent } from './providers/codex-hook-trust.js';

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
    expect(config).toContain('model_context_window = 400000');
    expect(config).toContain('model_auto_compact_token_limit = 360000');
    expect(config.indexOf('model_context_window = 400000')).toBeLessThan(config.indexOf('[features]'));
    expect(config.indexOf('model_auto_compact_token_limit = 360000')).toBeLessThan(config.indexOf('[features]'));
    expect(config).toContain('[features]');
    expect(config).toContain('hooks = true');
    expect(config).toContain('context_management = true');
    expect(config).toContain('fast_mode = false');
    expect(config).toContain('multi_agent = true');
    expect(config).toContain('[agents]');
    // Operator, 2026-09-17: no global subagent effort — Codex's native default
    // unless the spawn or the role names one (matches the host config).
    expect(config).not.toContain('default_subagent_reasoning_effort');
    expect(config).toContain('max_concurrent_threads_per_session = 5');
    expect(config).not.toContain('multi_agent_v2');
    expect(config).not.toContain('remote_control');
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
    // `writeCodexHooksAndTrust`, not `writeCodexHooksJson`: Codex will not
    // dispatch a hook with no matching `[hooks.state.*]` trust entry, so the
    // bare file write leaves the guard chain loaded and inert.
    expect(source).toMatch(/writeCodexHooksAndTrust\(\{\s*codexHome:\s*RUNTIME_CODEX_DIR\s*\}\)/);
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
    // mkdir, auth symlink, config.toml write, hooks.json+trust write, and the
    // post-registration trust re-sync — all five hand the sentinel back to the
    // caller. The re-sync counts because `codex plugin add` has already
    // rewritten config.toml by then, so a failure there leaves NO trust entries
    // standing rather than the pre-registration ones.
    expect(body.match(/return failClosed\(/g) ?? []).toHaveLength(5);
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
      {
        name: 'skills',
        action: 'register',
        entryName: 'wix',
        marketplaceName: 'skills',
        repoName: 'skills',
        pluginDir: dir,
      },
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
      // Dir holding the `.codex-plugin` manifest — what hook-trust reads the
      // plugin's declared hooks file from.
      pluginDir: registerable,
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
      // The SUB-directory, not the repo root: that is where the manifest and
      // any declared hooks file live.
      pluginDir: sub,
    });
    expect(byName.has('monorepo/not-checked-out')).toBe(false);
  });

  it('never registers a sub-plugin directory that carries no Codex manifest', () => {
    // A manifest-less directory is skipped: `readCodexPluginEntryName` returns
    // null and `findCodexSubPlugins` drops it, in both layouts the walker
    // descends. NOTE this pins walker behaviour, NOT an exclusion — a
    // sub-plugin named in `excludePlugins` still reaches this walker intact,
    // because the host mask that used to blank it was removed (#826). The
    // follow-up that teaches this walker the exclusion list will build on
    // exactly this skip.
    const repo = path.join(root, 'bootstrap');
    writeJson(path.join(repo, '.agents', 'plugins', 'marketplace.json'), { name: 'bootstrap-mkt' });
    const kept = path.join(repo, 'plugins', 'wwbd');
    writeJson(path.join(kept, '.codex-plugin', 'plugin.json'), { name: 'wwbd' });
    fs.mkdirSync(path.join(repo, 'plugins', 'orchestrate'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'rootlevel'), { recursive: true });

    const plans = planCodexPluginRegistration(root);
    expect(plans.map((p) => p.name)).toEqual(['bootstrap/wwbd']);
  });
});

// ── Hook trust wiring ──────────────────────────────────────────────────────
// Codex >=0.154 loads an untrusted hook and then never dispatches it, with no
// error anywhere. So the invariant worth guarding is not "we call the trust
// function" but the EFFECT: read back the two files a spawn actually leaves on
// disk and prove every hook in one is trusted by the other.

/** Minimal `[hooks.state."<key>"] trusted_hash = "<hash>"` reader. */
function parseTrustEntries(toml: string): Map<string, string> {
  const entries = new Map<string, string>();
  let current: string | null = null;
  for (const line of toml.split('\n')) {
    const header = parseTomlTableHeader(line);
    if (header !== null) {
      const match = header.match(/^hooks\.state\."(.*)"$/);
      current = match ? match[1] : null;
      continue;
    }
    const hash = current && line.match(/^\s*trusted_hash\s*=\s*"([^"]+)"\s*$/);
    if (hash) entries.set(current as string, hash[1]);
  }
  return entries;
}

describe('readCodexConfigToml', () => {
  // Every config.toml read in this module exists only to REWRITE the file from
  // what it read, so "could not look" collapsing into "nothing there" does not
  // lose a read, it loses the file — and the write then succeeds, which is why
  // no caller notices. Three answers, not two.
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-read-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the contents when the file is readable', () => {
    const p = path.join(dir, 'config.toml');
    fs.writeFileSync(p, '[features]\nhooks = true\n');
    expect(readCodexConfigToml(p)).toBe('[features]\nhooks = true\n');
  });

  it('answers empty for an absent file — ENOENT is the only absence', () => {
    expect(readCodexConfigToml(path.join(dir, 'missing.toml'))).toBe('');
    // A missing PARENT is ENOENT too, and is genuinely absent.
    expect(readCodexConfigToml(path.join(dir, 'nodir', 'config.toml'))).toBe('');
  });

  it('throws for a file that exists but cannot be read', () => {
    const p = path.join(dir, 'config.toml');
    fs.writeFileSync(p, '[features]\nhooks = true\n');
    fs.chmodSync(p, 0o200);
    try {
      expect(() => readCodexConfigToml(p)).toThrow(/could not read Codex config/i);
    } finally {
      fs.chmodSync(p, 0o600);
    }
  });

  it('is the only way ANY config.toml writer reads one, across all three modules', () => {
    // The pattern audit, not a grep done once by hand: the defect was
    // `existsSync(p) ? readFileSync(p) : ''` at the site that feeds every
    // OAuth fallback home, which `existsSync` answering false on EACCES turns
    // into an empty projection over all of them — and, separately,
    // `catch { base = '' }` in the MCP writer, which turned an unreadable-but-
    // writable config.toml into a file TRUNCATED to MCP tables. Reintroducing
    // either shape in any of the three modules that touch a config.toml fails
    // here; auditing only this file is what let the MCP writer keep its copy.
    const owner = fs.readFileSync(new URL('./providers/codex-config-file.ts', import.meta.url), 'utf-8');
    const helperAt = owner.indexOf('export function readCodexConfigToml');
    expect(helperAt).toBeGreaterThan(-1);
    const helper = owner.slice(helperAt, owner.indexOf('\n}\n', helperAt));
    // …and the helper itself is still the three-answer one.
    expect(helper).toContain("code === 'ENOENT'");

    const audited: Array<[string, string]> = [
      ['codex-config-file.ts', owner.slice(0, helperAt) + owner.slice(helperAt + helper.length)],
      ['codex-companion-setup.ts', fs.readFileSync(new URL('./codex-companion-setup.ts', import.meta.url), 'utf-8')],
      [
        'providers/codex-app-server.ts',
        fs.readFileSync(new URL('./providers/codex-app-server.ts', import.meta.url), 'utf-8'),
      ],
    ];
    // Report the offending LINES, not the whole file — a 900-line diff in the
    // failure message is a test nobody reads.
    const offenders: string[] = [];
    for (const [name, source] of audited) {
      for (const line of source.split('\n')) {
        if (
          /existsSync\([^)]*[Cc]onfig[^)]*\)\s*\?/.test(line) ||
          /readFileSync\([^)]*[Cc]onfig(Path|TomlPath)/.test(line)
        ) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every in-tree config.toml commit goes through the durable writer', () => {
    // The other half of the same class. A plain `writeFileSync(<configPath>, …)`
    // truncates in place, so an ENOSPC after the open leaves the file empty or
    // partial and the NEXT spawn reads the damage as its base. One writer
    // keeping a plain write buys nothing for the others sharing the file.
    for (const rel of ['./codex-companion-setup.ts', './providers/codex-app-server.ts']) {
      const source = fs.readFileSync(new URL(rel, import.meta.url), 'utf-8');
      const offenders = source
        .split('\n')
        .filter((line) =>
          /writeFileSync\(\s*(configTomlPath|configPath|runtimeConfigPath|fallbackConfigPath)/.test(line),
        )
        .map((line) => `${rel}: ${line.trim()}`);
      expect(offenders).toEqual([]);
    }
  });
});

describe('writeCodexHooksAndTrust', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-trust-home-'));
    fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nhooks = true\n');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('throws rather than returning when the TRUST write specifically fails', () => {
    // The postcondition is "hooks written AND trusted". Reporting success with
    // only the first half is the state this module exists to eliminate: codex
    // loads the handlers, reports them untrusted, never dispatches them, and
    // the app-server starts anyway — the destructive-action guard present,
    // inert and silent. Every caller continues straight into a spawn, so the
    // failure has to reach them.
    //
    // The directory stays WRITABLE and the commit is blocked at the temp file,
    // so hooks.json is written normally and the trust write is the one thing
    // that fails. An unwritable directory would fail the hooks.json write first
    // and this test would pass with the trust failure still swallowed — which
    // is exactly what it did before the message assertion below was added.
    //
    // A read-only config.toml is NOT the lever any more, and that is the
    // durable writer working: it commits by rename, which the DIRECTORY's mode
    // governs, so a 0400 config.toml is now correctly replaced rather than
    // blocking the guard wiring. The lever is a leftover read-only
    // `config.toml.tmp` — the shape a crashed write can leave behind — which
    // makes the `open(…, 'w')` fail with EACCES.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-trust-ro-'));
    const configPath = path.join(home, 'config.toml');
    const tmpPath = `${configPath}.tmp`;
    fs.writeFileSync(configPath, '[features]\nhooks = true\n');
    fs.writeFileSync(tmpPath, 'leftover');
    fs.chmodSync(tmpPath, 0o400);
    try {
      expect(() => writeCodexHooksAndTrust({ codexHome: home, pluginsRoot: path.join(home, 'no-plugins') })).toThrow(
        /hook trust/i,
      );
      // hooks.json really was written — so the throw is the trust write, not
      // an earlier step failing for an unrelated reason.
      expect(fs.existsSync(path.join(home, 'hooks.json'))).toBe(true);
      // …and the last valid config is still standing, untouched.
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('[features]\nhooks = true\n');
      // The failed commit cleaned up after itself: `unlink(2)` needs write on
      // the DIRECTORY, so even the read-only temp file goes, and the next spawn
      // is not blocked by the wreckage of this one.
      expect(fs.existsSync(tmpPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('REPLACES a read-only config.toml, because the commit is a rename the directory governs', () => {
    // Pinned as a deliberate behavior change from the plain `writeFileSync`
    // this replaced: a 0400 config.toml used to make the trust write fail and
    // refuse the spawn, which is the safe answer but not the right one — the
    // guard wiring should land. `rename(2)` needs write on the DIRECTORY, not
    // on the target file.
    const roHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-trust-ro-replaced-'));
    const configPath = path.join(roHome, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nhooks = true\n');
    fs.chmodSync(configPath, 0o400);
    try {
      writeCodexHooksAndTrust({ codexHome: roHome, pluginsRoot: path.join(roHome, 'no-plugins') });
      const committed = fs.readFileSync(configPath, 'utf-8');
      expect(committed).toContain('[features]');
      expect(committed).toContain('[hooks.state.');
      // No temp file left behind on the success path.
      expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
    } finally {
      fs.rmSync(roHome, { recursive: true, force: true });
    }
  });

  it('throws, and leaves config.toml untouched, when the config is unreadable but writable', () => {
    // The read side of the same class as the test above, and the one that is
    // worse: rewriting from an empty base SUCCEEDS, so nothing fails, and the
    // file it writes has lost `[features] hooks = true` — codex then loads no
    // hooks at all and the app-server starts. Mode 0200 is the live shape (a
    // mount that kept write and lost read); only ENOENT means "absent".
    const roHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-trust-unreadable-'));
    const configPath = path.join(roHome, 'config.toml');
    const original = '[features]\nhooks = true\n\n[marketplaces.mkt]\nsource_type = "local"\n';
    fs.writeFileSync(configPath, original);
    fs.chmodSync(configPath, 0o200);
    try {
      expect(() =>
        writeCodexHooksAndTrust({ codexHome: roHome, pluginsRoot: path.join(roHome, 'no-plugins') }),
      ).toThrow(/could not read Codex config/i);
      fs.chmodSync(configPath, 0o600);
      // The feature flag and the plugin tables are still there — the refusal
      // happened BEFORE the rewrite, not after a partial one.
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
    } finally {
      fs.chmodSync(configPath, 0o600);
      fs.rmSync(roHome, { recursive: true, force: true });
    }
  });

  it('leaves every hook it wrote to hooks.json trusted in config.toml', () => {
    writeCodexHooksAndTrust({ codexHome: home, pluginsRoot: path.join(home, 'no-plugins') });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: unknown[] }>>;
    };
    const trusted = parseTrustEntries(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'));

    const expectedKeys: string[] = [];
    for (const [event, groups] of Object.entries(hooksJson.hooks)) {
      expect(isCodexHookEvent(event)).toBe(true);
      groups.forEach((group, gi) =>
        group.hooks.forEach((_handler, hi) =>
          // Keyed on the home this call actually wrote to — that is what makes
          // an OAuth-fallback rotation carry its own trust entries.
          expectedKeys.push(`${path.join(home, 'hooks.json')}:${codexHookEventKey(event as never)}:${gi}:${hi}`),
        ),
      );
    }

    expect(expectedKeys.length).toBeGreaterThan(0);
    for (const key of expectedKeys) {
      expect(trusted.get(key)).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // No orphan rows either: an entry keyed on a hook that no longer exists is
    // dead weight that hides a rename.
    expect([...trusted.keys()].sort()).toEqual(expectedKeys.sort());
    // And the pre-existing config is still there.
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8')).toContain('hooks = true');
  });

  it('is what the codex provider calls at every hooks.json write', () => {
    // Four call sites: the pre-spawn write and three OAuth-rotation rewrites.
    // A bare `writeCodexHooksJson()` at any of them writes the guard chain into
    // a home with no trust entries, where it loads and never fires.
    const source = fs.readFileSync(new URL('./providers/codex.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bwriteCodexHooksJson\s*\(/);
    expect(source.match(/\bwriteCodexHooksAndTrust\s*\(/g)).toHaveLength(4);
  });

  it('trusts the hooks a mounted plugin declares, keyed <plugin>@<marketplace>', () => {
    // The Claude provider already dispatches these same plugins' hooks through
    // the SDK; leaving them untrusted under Codex is a provider asymmetry, not
    // isolation — it is why the workflow-agents Codex guard was inert.
    const pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-plugins-'));
    try {
      const repo = path.join(pluginsRoot, 'bootstrap');
      const sub = path.join(repo, 'plugins', 'workflow-agents');
      fs.mkdirSync(path.join(repo, '.agents', 'plugins'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, '.agents', 'plugins', 'marketplace.json'),
        JSON.stringify({ name: 'davekim917-bootstrap' }),
      );
      fs.mkdirSync(path.join(sub, '.codex-plugin'), { recursive: true });
      fs.mkdirSync(path.join(sub, 'hooks'), { recursive: true });
      fs.writeFileSync(
        path.join(sub, '.codex-plugin', 'plugin.json'),
        JSON.stringify({ name: 'bootstrap-workflow-agents', hooks: './hooks/workflow-hooks.json' }),
      );
      fs.writeFileSync(
        path.join(sub, 'hooks', 'workflow-hooks.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  { type: 'command', command: 'bun "${PLUGIN_ROOT}/hooks/codex-guard.ts" PreToolUse', timeout: 3600 },
                ],
              },
            ],
          },
        }),
      );

      writeCodexHooksAndTrust({ codexHome: home, pluginsRoot });
      const trusted = parseTrustEntries(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'));
      // Hash pinned to what Codex itself wrote for this exact hook, so this
      // asserts interoperability, not just self-consistency.
      expect(
        trusted.get('bootstrap-workflow-agents@davekim917-bootstrap:hooks/workflow-hooks.json:pre_tool_use:0:0'),
      ).toBe('sha256:098408625edddbfeabfdc5593d17ade95699bf36fd463bd17ffd604cf314cb4a');
      // The generated guard chain is still trusted alongside it.
      expect(trusted.has(`${path.join(home, 'hooks.json')}:pre_tool_use:0:0`)).toBe(true);
    } finally {
      fs.rmSync(pluginsRoot, { recursive: true, force: true });
    }
  });

  it('re-keys the entries when the home rotates', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-trust-home2-'));
    try {
      const pluginsRoot = path.join(home, 'no-plugins');
      writeCodexHooksAndTrust({ codexHome: home, pluginsRoot });
      writeCodexHooksAndTrust({ codexHome: other, pluginsRoot });
      const rotated = [...parseTrustEntries(fs.readFileSync(path.join(other, 'config.toml'), 'utf-8')).keys()];
      expect(rotated.length).toBeGreaterThan(0);
      expect(rotated.every((key) => key.startsWith(path.join(other, 'hooks.json') + ':'))).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('tracks a changed hook command instead of leaving the old hash trusted', () => {
    const pluginsRoot = path.join(home, 'no-plugins');
    writeCodexHooksAndTrust({ codexHome: home, emailGateTimeoutSec: 3600, pluginsRoot });
    const before = parseTrustEntries(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'));
    writeCodexHooksAndTrust({ codexHome: home, emailGateTimeoutSec: 120, pluginsRoot });
    const after = parseTrustEntries(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'));

    const preKey = `${path.join(home, 'hooks.json')}:pre_tool_use:0:0`;
    expect(before.get(preKey)).toBeDefined();
    expect(after.get(preKey)).toBeDefined();
    // The PreToolUse timeout is part of the hashed identity, so the entry must
    // move; the untouched PostToolUse entry must not.
    expect(after.get(preKey)).not.toBe(before.get(preKey));
    const postKey = `${path.join(home, 'hooks.json')}:post_tool_use:0:0`;
    expect(after.get(postKey)).toBe(before.get(postKey) as string);
    // Sanity: the hooks.json really did change, so the assertion above is not
    // passing on a no-op.
    expect(buildCodexHooksJson({ emailGateTimeoutSec: 120 }).hooks.PreToolUse[0].hooks[0].timeout).toBe(120);
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

// ── verifyCodexHookTrust ───────────────────────────────────────────────────

/**
 * Minimal app-server stub: `sendCodexRequest` writes a JSON-RPC line to
 * `process.stdin` and resolves whatever it finds in `pending`, so a stub only
 * has to answer on that path.
 */
function hookListServer(answer: { result?: unknown; error?: { code: number; message: string } } | null): AppServer {
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  return {
    process: {
      stdin: {
        write(line: string) {
          const request = JSON.parse(line) as { id: number };
          if (answer) {
            queueMicrotask(() => {
              const handler = pending.get(request.id);
              pending.delete(request.id);
              handler?.resolve({ id: request.id, ...answer } as never);
            });
          }
          return true;
        },
      },
      kill: () => true,
    },
    readline: { close() {} },
    pending,
    notificationHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
}

/** The keys `syncCodexHookTrust` writes for a given home, from the same collector. */
function generatedKeys(home: string): string[] {
  return collectCodexHookTrustEntries(path.join(home, 'hooks.json'), buildCodexHooksJson().hooks).map((e) => e.key);
}

function listing(rows: Array<Record<string, unknown>>): { result: unknown } {
  return { result: { data: [{ cwd: '/workspace/agent', hooks: rows, warnings: [], errors: [] }] } };
}

describe('verifyCodexHookTrust', () => {
  const HOME = '/probe/codex-home';

  it('passes when every generated handler reads back trusted and enabled', async () => {
    const rows = generatedKeys(HOME).map((key) => ({ key, enabled: true, trustStatus: 'trusted' }));
    await verifyCodexHookTrust(hookListServer(listing(rows)), HOME);
  });

  it('REFUSES the spawn when a generated handler reads back untrusted', async () => {
    // The failure this check exists for: the handler loads, codex reports it
    // untrusted, never dispatches it, and the session otherwise runs normally.
    const keys = generatedKeys(HOME);
    const rows = keys.map((key, i) => ({ key, enabled: true, trustStatus: i === 0 ? 'untrusted' : 'trusted' }));
    await expect(verifyCodexHookTrust(hookListServer(listing(rows)), HOME)).rejects.toThrow(
      /hook trust verification failed/i,
    );
  });

  it('REFUSES the spawn when the listing is empty', async () => {
    // Hooks feature off, or hooks.json unread: nothing bad to find in the
    // listing, and the whole guard chain is inert.
    await expect(verifyCodexHookTrust(hookListServer(listing([])), HOME)).rejects.toThrow(/missing/);
  });

  it('REFUSES the spawn when a generated handler is trusted but DISABLED', async () => {
    const rows = generatedKeys(HOME).map((key, i) => ({ key, enabled: i !== 0, trustStatus: 'trusted' }));
    await expect(verifyCodexHookTrust(hookListServer(listing(rows)), HOME)).rejects.toThrow(/enabled=false/);
  });

  it('REFUSES the spawn when hooks/list itself fails', async () => {
    // Fail closed on a version drift that removes or renames the method: the
    // alternative is the same silence the check exists to end.
    const server = hookListServer({ error: { code: -32601, message: 'method not found' } });
    await expect(verifyCodexHookTrust(server, HOME)).rejects.toThrow(/hooks\/list unavailable/);
  });

  it('keys the expected set on the home passed in, so a rotated CODEX_HOME is checked against ITS own hooks.json', async () => {
    // An OAuth-fallback rotation moves CODEX_HOME; trust entries are keyed on
    // the absolute hooks.json path, so rows from the OLD home must not satisfy
    // the check for the new one.
    const rows = generatedKeys('/probe/fallback-home').map((key) => ({ key, enabled: true, trustStatus: 'trusted' }));
    await expect(verifyCodexHookTrust(hookListServer(listing(rows)), HOME)).rejects.toThrow(/missing/);
  });

  it('does NOT fail on an undispatchable plugin handler', async () => {
    // Reported, not fatal: one oddly-shaped third-party plugin must not take
    // the container down, and the guard core depends on no plugin.
    const rows = [
      ...generatedKeys(HOME).map((key) => ({ key, enabled: true, trustStatus: 'trusted' })),
      {
        key: 'some-plugin@mkt:hooks/hooks.json:pre_tool_use:0:0',
        pluginId: 'some-plugin@mkt',
        enabled: true,
        trustStatus: 'untrusted',
      },
    ];
    await verifyCodexHookTrust(hookListServer(listing(rows)), HOME);
  });
});
