import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { syncCodexAgentsMd, syncCodexLocalMarketplacePluginCache } from './codex-sync.js';

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
