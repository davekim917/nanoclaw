import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { discoverCodexAgentTargets, syncCodexLocalMarketplacePluginCache, syncCodexSubagents } from './codex-sync.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sync-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function writeCodexPlugin(root: string, version: string, body: string): void {
  writeJson(path.join(root, '.codex-plugin', 'plugin.json'), {
    name: 'bootstrap-workflow-agents',
    version,
    skills: './skills/',
  });
  fs.mkdirSync(path.join(root, 'skills', 'team-build'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', 'team-build', 'SKILL.md'),
    `---\nname: team-build\ndescription: Build\n---\n\n${body}\n`,
  );
}

describe('syncCodexLocalMarketplacePluginCache', () => {
  it('copies enabled local marketplace plugins into the Codex plugin cache', () => {
    const marketplaceRoot = path.join(tmpDir, 'plugins', 'bootstrap');
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'workflow-agents');
    writeCodexPlugin(pluginRoot, '0.1.0', 'first body');
    writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: 'davekim917-bootstrap',
      plugins: [
        {
          name: 'bootstrap-workflow-agents',
          source: { source: 'local', path: './plugins/workflow-agents' },
        },
      ],
    });
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.codex', 'config.toml'),
      [
        '[plugins."bootstrap-workflow-agents@davekim917-bootstrap"]',
        'enabled = true',
        '',
        '[marketplaces.davekim917-bootstrap]',
        'source_type = "local"',
        `source = "${marketplaceRoot}"`,
        '',
      ].join('\n'),
    );

    const result = syncCodexLocalMarketplacePluginCache();

    expect(result.errors).toEqual([]);
    expect(result.installed).toEqual(['bootstrap-workflow-agents@davekim917-bootstrap']);
    const cachedSkill = path.join(
      tmpDir,
      '.codex',
      'plugins',
      'cache',
      'davekim917-bootstrap',
      'bootstrap-workflow-agents',
      'local',
      'skills',
      'team-build',
      'SKILL.md',
    );
    expect(fs.readFileSync(cachedSkill, 'utf-8')).toContain('first body');

    writeCodexPlugin(pluginRoot, '0.1.1', 'second body');
    const update = syncCodexLocalMarketplacePluginCache();
    expect(update.updated).toEqual(['bootstrap-workflow-agents@davekim917-bootstrap']);
    expect(fs.readFileSync(cachedSkill, 'utf-8')).toContain('second body');
  });

  it('does not cache disabled local marketplace plugins', () => {
    const marketplaceRoot = path.join(tmpDir, 'plugins', 'bootstrap');
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'workflow-agents');
    writeCodexPlugin(pluginRoot, '0.1.0', 'body');
    writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: 'davekim917-bootstrap',
      plugins: [
        {
          name: 'bootstrap-workflow-agents',
          source: { source: 'local', path: './plugins/workflow-agents' },
        },
      ],
    });
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.codex', 'config.toml'),
      [
        '[plugins."bootstrap-workflow-agents@davekim917-bootstrap"]',
        'enabled = false',
        '',
        '[marketplaces.davekim917-bootstrap]',
        'source_type = "local"',
        `source = "${marketplaceRoot}"`,
        '',
      ].join('\n'),
    );

    const result = syncCodexLocalMarketplacePluginCache();

    expect(result.installed).toEqual([]);
    expect(result.skipped).toContain('bootstrap-workflow-agents@davekim917-bootstrap:disabled');
    expect(
      fs.existsSync(
        path.join(tmpDir, '.codex', 'plugins', 'cache', 'davekim917-bootstrap', 'bootstrap-workflow-agents', 'local'),
      ),
    ).toBe(false);
  });

  it('copies enabled Git marketplace plugins from Codex marketplace checkouts using the plugin version', () => {
    const marketplaceRoot = path.join(tmpDir, '.codex', '.tmp', 'marketplaces', 'davekim917-bootstrap');
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'workflow-agents');
    writeCodexPlugin(pluginRoot, '0.1.0', 'git body');
    writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: 'davekim917-bootstrap',
      plugins: [
        {
          name: 'bootstrap-workflow-agents',
          source: { source: 'local', path: './plugins/workflow-agents' },
        },
      ],
    });
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.codex', 'config.toml'),
      [
        '[plugins."bootstrap-workflow-agents@davekim917-bootstrap"]',
        'enabled = true',
        '',
        '[marketplaces.davekim917-bootstrap]',
        'source_type = "git"',
        'source = "https://github.com/davekim917/bootstrap.git"',
        'ref = "main"',
        'last_revision = "3eb8fabbac0f019a8b65e061db96673d3b43ef1a"',
        '',
      ].join('\n'),
    );

    const result = syncCodexLocalMarketplacePluginCache();

    expect(result.errors).toEqual([]);
    expect(result.installed).toEqual(['bootstrap-workflow-agents@davekim917-bootstrap']);
    const cachedSkill = path.join(
      tmpDir,
      '.codex',
      'plugins',
      'cache',
      'davekim917-bootstrap',
      'bootstrap-workflow-agents',
      '0.1.0',
      'skills',
      'team-build',
      'SKILL.md',
    );
    expect(fs.readFileSync(cachedSkill, 'utf-8')).toContain('git body');
  });
});

describe('discoverCodexAgentTargets', () => {
  it('adds groups/<folder>/.codex/agents for provider=codex groups only', () => {
    const groupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sync-groups-'));
    try {
      // provider=codex → target
      fs.mkdirSync(path.join(groupsDir, 'acme-codex'));
      fs.writeFileSync(path.join(groupsDir, 'acme-codex', 'container.json'), JSON.stringify({ provider: 'codex' }));
      // provider=claude, no codex peer → no target
      fs.mkdirSync(path.join(groupsDir, 'acme'));
      fs.writeFileSync(path.join(groupsDir, 'acme', 'container.json'), JSON.stringify({ provider: 'claude' }));
      // provider=claude with codex-as-peer → target
      fs.mkdirSync(path.join(groupsDir, 'acme-peer'));
      fs.writeFileSync(
        path.join(groupsDir, 'acme-peer', 'container.json'),
        JSON.stringify({ provider: 'claude', codexHostAuth: true }),
      );
      // malformed container.json → skipped, no throw
      fs.mkdirSync(path.join(groupsDir, 'broken-codex'));
      fs.writeFileSync(path.join(groupsDir, 'broken-codex', 'container.json'), '{nope');

      const targets = discoverCodexAgentTargets(groupsDir);
      expect(targets).toContain(path.join(groupsDir, 'acme-codex', '.codex', 'agents'));
      expect(targets).not.toContain(path.join(groupsDir, 'acme', '.codex', 'agents'));
      expect(targets).toContain(path.join(groupsDir, 'acme-peer', '.codex', 'agents'));
      expect(targets).not.toContain(path.join(groupsDir, 'broken-codex', '.codex', 'agents'));
      // the global host-CLI roster target is still present
      expect(targets).toContain(path.join(os.homedir(), '.codex', 'agents'));
    } finally {
      fs.rmSync(groupsDir, { recursive: true, force: true });
    }
  });
});

describe('retired worker sync', () => {
  it('removes source-retired managed workers but preserves unmanaged and specialized roles', () => {
    const source = path.join(tmpDir, '.claude/agents');
    const target = path.join(tmpDir, '.codex/agents');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    for (const name of ['worker-fast', 'worker', 'worker-high', 'worker-codex']) {
      fs.writeFileSync(path.join(target, `${name}.toml`), '# managed by nanoclaw codex-sync\n');
    }
    fs.writeFileSync(path.join(target, 'custom.toml'), 'name = "custom"\n');
    fs.writeFileSync(
      path.join(source, 'impeccable-reviewer.md'),
      '---\nname: impeccable-reviewer\ndescription: Specialized review\n---\nReview.\n',
    );
    syncCodexSubagents();
    for (const name of ['worker-fast', 'worker', 'worker-high', 'worker-codex']) {
      expect(fs.existsSync(path.join(target, `${name}.toml`))).toBe(false);
    }
    expect(fs.readFileSync(path.join(target, 'custom.toml'), 'utf8')).toBe('name = "custom"\n');
    expect(fs.existsSync(path.join(target, 'impeccable-reviewer.toml'))).toBe(true);
  });
});
