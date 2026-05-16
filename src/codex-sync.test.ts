import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { syncCodexLocalMarketplacePluginCache } from './codex-sync.js';

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
    name: 'bootstrap-workflow-codex',
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
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'workflow-codex');
    writeCodexPlugin(pluginRoot, '0.1.0', 'first body');
    writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: 'davekim917-bootstrap',
      plugins: [
        {
          name: 'bootstrap-workflow-codex',
          source: { source: 'local', path: './plugins/workflow-codex' },
        },
      ],
    });
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.codex', 'config.toml'),
      [
        '[plugins."bootstrap-workflow-codex@davekim917-bootstrap"]',
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
    expect(result.installed).toEqual(['bootstrap-workflow-codex@davekim917-bootstrap']);
    const cachedSkill = path.join(
      tmpDir,
      '.codex',
      'plugins',
      'cache',
      'davekim917-bootstrap',
      'bootstrap-workflow-codex',
      'local',
      'skills',
      'team-build',
      'SKILL.md',
    );
    expect(fs.readFileSync(cachedSkill, 'utf-8')).toContain('first body');

    writeCodexPlugin(pluginRoot, '0.1.1', 'second body');
    const update = syncCodexLocalMarketplacePluginCache();
    expect(update.updated).toEqual(['bootstrap-workflow-codex@davekim917-bootstrap']);
    expect(fs.readFileSync(cachedSkill, 'utf-8')).toContain('second body');
  });

  it('does not cache disabled local marketplace plugins', () => {
    const marketplaceRoot = path.join(tmpDir, 'plugins', 'bootstrap');
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'workflow-codex');
    writeCodexPlugin(pluginRoot, '0.1.0', 'body');
    writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: 'davekim917-bootstrap',
      plugins: [
        {
          name: 'bootstrap-workflow-codex',
          source: { source: 'local', path: './plugins/workflow-codex' },
        },
      ],
    });
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.codex', 'config.toml'),
      [
        '[plugins."bootstrap-workflow-codex@davekim917-bootstrap"]',
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
    expect(result.skipped).toContain('bootstrap-workflow-codex@davekim917-bootstrap:disabled');
    expect(
      fs.existsSync(
        path.join(tmpDir, '.codex', 'plugins', 'cache', 'davekim917-bootstrap', 'bootstrap-workflow-codex', 'local'),
      ),
    ).toBe(false);
  });
});
