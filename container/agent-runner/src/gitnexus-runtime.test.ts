import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  configureGitNexusRuntime,
  prepareGitNexusPluginForClaude,
} from './gitnexus-runtime.js';
import type { McpServerConfig } from './providers/types.js';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createGitNexusPlugin(root: string): string {
  const pluginDir = path.join(root, 'gitnexus', 'gitnexus-claude-plugin');
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'skills', 'gitnexus-guide'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'gitnexus' }),
  );
  fs.writeFileSync(
    path.join(pluginDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        gitnexus: { command: 'npx', args: ['-y', 'gitnexus@latest', 'mcp'] },
      },
    }),
  );
  fs.writeFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), '{}');
  fs.writeFileSync(path.join(pluginDir, 'skills', 'gitnexus-guide', 'SKILL.md'), '# GitNexus');
  return pluginDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('configureGitNexusRuntime', () => {
  it('injects the pinned CLI only when the GitNexus plugin and binary exist', () => {
    const root = tempDir('gitnexus-runtime-');
    createGitNexusPlugin(root);
    const cliPath = path.join(root, 'gitnexus-bin');
    fs.writeFileSync(cliPath, '#!/bin/sh\n');
    const servers: Record<string, McpServerConfig> = {};

    const result = configureGitNexusRuntime(servers, {
      pluginsRoot: root,
      cliPath,
      injectInstructions: true,
    });

    expect(result.active).toBe(true);
    expect(result.injected).toBe(true);
    expect(result.instructions).toContain('GitNexus plugin is active');
    expect(servers.gitnexus).toEqual({
      type: 'stdio',
      command: cliPath,
      args: ['mcp'],
      env: {},
    });
  });

  it('does nothing when the plugin is absent', () => {
    const root = tempDir('gitnexus-runtime-missing-');
    const servers: Record<string, McpServerConfig> = {};

    const result = configureGitNexusRuntime(servers, {
      pluginsRoot: root,
      cliPath: path.join(root, 'gitnexus-bin'),
      injectInstructions: true,
    });

    expect(result).toEqual({ active: false, injected: false });
    expect(servers).toEqual({});
  });

  it('does not inject hard guidance when the plugin exists but the pinned CLI is unavailable', () => {
    const root = tempDir('gitnexus-runtime-no-cli-');
    createGitNexusPlugin(root);
    const servers: Record<string, McpServerConfig> = {};

    const result = configureGitNexusRuntime(servers, {
      pluginsRoot: root,
      cliPath: path.join(root, 'missing-gitnexus-bin'),
      injectInstructions: true,
    });

    expect(result).toEqual({ active: false, injected: false });
    expect(servers).toEqual({});
  });

  it('honors excludeMcpServers and preserves an explicit operator override', () => {
    const root = tempDir('gitnexus-runtime-exclude-');
    createGitNexusPlugin(root);
    const cliPath = path.join(root, 'gitnexus-bin');
    fs.writeFileSync(cliPath, '#!/bin/sh\n');

    const excluded: Record<string, McpServerConfig> = {};
    expect(
      configureGitNexusRuntime(excluded, {
        pluginsRoot: root,
        cliPath,
        excludedMcpServers: ['gitnexus'],
        injectInstructions: true,
      }),
    ).toEqual({ active: false, injected: false });

    const override: McpServerConfig = {
      type: 'stdio',
      command: '/operator/gitnexus',
      args: ['mcp'],
      env: { MODE: 'custom' },
    };
    const servers = { gitnexus: override };
    const result = configureGitNexusRuntime(servers, {
      pluginsRoot: root,
      cliPath,
      injectInstructions: true,
    });

    expect(result.active).toBe(true);
    expect(result.injected).toBe(false);
    expect(servers.gitnexus).toBe(override);
  });

  it('keeps tools active but omits hard instructions when instruction injection is disabled', () => {
    const root = tempDir('gitnexus-runtime-no-instructions-');
    createGitNexusPlugin(root);
    const cliPath = path.join(root, 'gitnexus-bin');
    fs.writeFileSync(cliPath, '#!/bin/sh\n');
    const servers: Record<string, McpServerConfig> = {};

    const result = configureGitNexusRuntime(servers, {
      pluginsRoot: root,
      cliPath,
      injectInstructions: false,
    });

    expect(result.active).toBe(true);
    expect(result.instructions).toBeUndefined();
  });
});

describe('prepareGitNexusPluginForClaude', () => {
  it('preserves plugin skills and hooks while suppressing its npx MCP manifest', () => {
    const root = tempDir('gitnexus-overlay-source-');
    const pluginDir = createGitNexusPlugin(root);
    const overlayRoot = tempDir('gitnexus-overlay-target-');

    const prepared = prepareGitNexusPluginForClaude(pluginDir, overlayRoot);

    expect(prepared).not.toBe(pluginDir);
    expect(fs.existsSync(path.join(prepared, '.mcp.json'))).toBe(false);
    expect(fs.readFileSync(path.join(prepared, '.claude-plugin', 'plugin.json'), 'utf8')).toContain('gitnexus');
    expect(fs.existsSync(path.join(prepared, 'hooks', 'hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(prepared, 'skills', 'gitnexus-guide', 'SKILL.md'))).toBe(true);
    expect(prepareGitNexusPluginForClaude(pluginDir, overlayRoot)).toBe(prepared);
  });

  it('leaves unrelated plugins unchanged', () => {
    const root = tempDir('other-plugin-');
    const pluginDir = path.join(root, 'other');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'other' }));
    fs.writeFileSync(path.join(pluginDir, '.mcp.json'), '{}');

    expect(prepareGitNexusPluginForClaude(pluginDir, tempDir('other-overlay-'))).toBe(pluginDir);
  });
});
