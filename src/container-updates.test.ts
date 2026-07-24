import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applySelectedUpdates,
  auditRepository,
  buildScheduledAuditGate,
  latestStableGitHubRelease,
  latestStableGitHubTag,
  latestStableNpmVersion,
  latestStablePyPiVersion,
  renderAuditMarkdown,
  type AuditItem,
} from './container-updates.js';

describe('latest-stable release policy', () => {
  it('rejects npm prerelease latest tags instead of silently selecting them', () => {
    expect(latestStableNpmVersion({ 'dist-tags': { latest: '3.0.0-rc.1' } })).toEqual({
      status: 'blocked',
      reason: 'npm latest tag is not a stable release: 3.0.0-rc.1',
    });
    expect(latestStableNpmVersion({ 'dist-tags': { latest: '2.4.1' } })).toEqual({
      status: 'resolved',
      version: '2.4.1',
    });
  });

  it('selects the highest non-yanked stable PyPI release with compatible files', () => {
    expect(
      latestStablePyPiVersion({
        releases: {
          '1.9.0': [{ yanked: false, packagetype: 'bdist_wheel' }],
          '2.0.0rc1': [{ yanked: false, packagetype: 'bdist_wheel' }],
          '2.0.0': [{ yanked: true, packagetype: 'bdist_wheel' }],
          '1.10.0': [{ yanked: false, packagetype: 'bdist_wheel' }],
          '3.0.0': [{ yanked: false, packagetype: 'sdist' }],
        },
      }),
    ).toEqual({ status: 'resolved', version: '1.10.0' });
  });

  it('ignores draft, prerelease, and prerelease-looking GitHub releases', () => {
    expect(
      latestStableGitHubRelease([
        { tag_name: 'v4.0.0', draft: true, prerelease: false },
        { tag_name: 'v3.0.0', draft: false, prerelease: true },
        { tag_name: 'nightly-20260719', draft: false, prerelease: false },
        { tag_name: 'v2.1.0', draft: false, prerelease: false, target_commitish: 'abc123' },
      ]),
    ).toEqual({ status: 'resolved', version: '2.1.0', tag: 'v2.1.0', commitish: 'abc123' });
  });

  it('selects the highest stable GitHub tag with its exact commit', () => {
    expect(
      latestStableGitHubTag([
        { name: 'v2.2.0-rc.1', commit: { sha: 'bad' } },
        { name: 'v2.1.0', commit: { sha: 'abc123' } },
      ]),
    ).toEqual({ status: 'resolved', version: '2.1.0', tag: 'v2.1.0', commitish: 'abc123' });
  });
});

describe('deterministic update application', () => {
  it('mutates only approved items and preserves dependency range style', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'container-updates-'));
    await mkdir(path.join(root, 'container', 'agent-runner'), { recursive: true });
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { exact: '1.0.0', caret: '^1.0.0' } }, null, 2) + '\n',
    );
    await writeFile(
      path.join(root, 'container', 'agent-runner', 'package.json'),
      JSON.stringify({ dependencies: { bunonly: '1.0.0' } }, null, 2) + '\n',
    );
    const items: AuditItem[] = [
      {
        id: 'host:exact',
        name: 'exact',
        kind: 'host-dependency',
        surface: 'host',
        current: '1.0.0',
        latest: '2.0.0',
        status: 'outdated',
        source: 'npm',
      },
      {
        id: 'host:caret',
        name: 'caret',
        kind: 'host-dependency',
        surface: 'host',
        current: '1.0.0',
        latest: '2.0.0',
        status: 'outdated',
        source: 'npm',
      },
    ];
    const commands: string[][] = [];
    await applySelectedUpdates({
      repoRoot: root,
      items,
      selectedIds: ['host:caret'],
      run: async (command) => {
        commands.push(command);
      },
    });
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual({ exact: '1.0.0', caret: '^2.0.0' });
    expect(commands).toEqual([['pnpm', 'install', '--lockfile-only']]);
  });

  it('rejects an empty or unknown selection before mutating files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'container-updates-'));
    const packagePath = path.join(root, 'package.json');
    await writeFile(packagePath, '{"dependencies":{"exact":"1.0.0"}}\n');
    const before = await readFile(packagePath, 'utf8');
    await expect(applySelectedUpdates({ repoRoot: root, items: [], selectedIds: [] })).rejects.toThrow(
      'at least one update item',
    );
    await expect(applySelectedUpdates({ repoRoot: root, items: [], selectedIds: ['missing'] })).rejects.toThrow(
      'unknown update item: missing',
    );
    expect(await readFile(packagePath, 'utf8')).toBe(before);
  });

  it('updates coupled Docker checksums and package-manager mirrors atomically', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'container-updates-'));
    await mkdir(path.join(root, 'container'), { recursive: true });
    const dockerfilePath = path.join(root, 'container', 'Dockerfile');
    await writeFile(dockerfilePath, 'ARG TOOL_VERSION=1.0.0\nARG TOOL_SHA256_arm64=' + 'a'.repeat(64) + '\n');
    await writeFile(path.join(root, 'package.json'), '{"packageManager":"pnpm@1.0.0"}\n');
    await writeFile(
      path.join(root, 'container', 'update-sources.json'),
      JSON.stringify({
        schemaVersion: 1,
        dockerfile: [
          {
            id: 'tool',
            name: 'tool',
            arg: 'TOOL_VERSION',
            source: { kind: 'github', repo: 'o/r' },
            checksums: [{ arg: 'TOOL_SHA256_arm64', url: 'https://example/{version}.sha256' }],
            mirrors: [{ file: 'package.json', jsonPath: ['packageManager'], format: 'pnpm@{version}' }],
          },
        ],
      }),
    );
    const item: AuditItem = {
      id: 'docker:tool',
      name: 'tool',
      kind: 'dockerfile-pin',
      surface: 'container',
      current: '1.0.0',
      latest: '2.0.0',
      status: 'outdated',
      source: 'github',
    };
    await applySelectedUpdates({
      repoRoot: root,
      items: [item],
      selectedIds: [item.id],
      fetchText: async (url) => {
        expect(url).toBe('https://example/2.0.0.sha256');
        return `${'b'.repeat(64)}  tool.tar.gz\n`;
      },
    });
    expect(await readFile(dockerfilePath, 'utf8')).toContain('ARG TOOL_VERSION=2.0.0');
    expect(await readFile(dockerfilePath, 'utf8')).toContain(`ARG TOOL_SHA256_arm64=${'b'.repeat(64)}`);
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).packageManager).toBe('pnpm@2.0.0');
  });

  it('does not change a Dockerfile when coupled checksum resolution fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'container-updates-'));
    await mkdir(path.join(root, 'container'), { recursive: true });
    const dockerfilePath = path.join(root, 'container', 'Dockerfile');
    const original = 'ARG TOOL_VERSION=1.0.0\nARG TOOL_SHA256_arm64=' + 'a'.repeat(64) + '\n';
    await writeFile(dockerfilePath, original);
    await writeFile(
      path.join(root, 'container', 'update-sources.json'),
      JSON.stringify({
        schemaVersion: 1,
        dockerfile: [
          {
            id: 'tool',
            name: 'tool',
            arg: 'TOOL_VERSION',
            source: { kind: 'github', repo: 'o/r' },
            checksums: [{ arg: 'TOOL_SHA256_arm64', url: 'https://example/{version}.sha256' }],
          },
        ],
      }),
    );
    const item: AuditItem = {
      id: 'docker:tool',
      name: 'tool',
      kind: 'dockerfile-pin',
      surface: 'container',
      current: '1.0.0',
      latest: '2.0.0',
      status: 'outdated',
      source: 'github',
    };
    await expect(
      applySelectedUpdates({
        repoRoot: root,
        items: [item],
        selectedIds: [item.id],
        fetchText: async () => 'invalid',
      }),
    ).rejects.toThrow('could not resolve SHA256');
    expect(await readFile(dockerfilePath, 'utf8')).toBe(original);
  });

  it('routes an approved Graphify update through the dedicated release adapter', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'container-updates-'));
    const item: AuditItem = {
      id: 'graphify:graphifyy',
      name: 'graphifyy',
      kind: 'graphify',
      surface: 'container',
      current: '0.9.25',
      latest: '0.9.26',
      status: 'outdated',
      source: 'pypi',
    };
    const commands: Array<{ command: string[]; cwd: string }> = [];
    await applySelectedUpdates({
      repoRoot: root,
      items: [item],
      selectedIds: [item.id],
      run: async (command, cwd) => {
        commands.push({ command, cwd });
      },
    });
    expect(commands).toEqual([
      {
        command: ['bun', 'scripts/update-graphify.ts', '--version', '0.9.26'],
        cwd: root,
      },
    ]);
  });
});

describe('audit rendering', () => {
  it('renders failures as unknown and never as current', () => {
    const markdown = renderAuditMarkdown([
      {
        id: 'docker:tool',
        name: 'tool',
        kind: 'dockerfile-pin',
        surface: 'container',
        current: '1.0.0',
        latest: null,
        status: 'unknown',
        source: 'github',
        detail: 'registry timeout',
      },
    ]);
    expect(markdown).toContain('| tool | dockerfile-pin | 1.0.0 | unknown | unknown |');
    expect(markdown).toContain('registry timeout');
    expect(markdown).not.toContain('up to date');
  });

  it('suppresses the scheduled agent on a deterministic no-op only', () => {
    const current: AuditItem = {
      id: 'host:current',
      name: 'current',
      kind: 'host-dependency',
      surface: 'host',
      current: '1.0.0',
      latest: '1.0.0',
      status: 'current',
      source: 'npm',
    };
    expect(buildScheduledAuditGate([current])).toMatchObject({ wakeAgent: false });
    expect(buildScheduledAuditGate([{ ...current, latest: null, status: 'unknown' }])).toMatchObject({
      wakeAgent: true,
      data: { summary: { unresolved: 1 } },
    });
  });
});

describe('tracked repository update surfaces', () => {
  it('maps every Docker package VERSION argument and keeps pnpm host parity', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const dockerfile = await readFile(path.join(root, 'container', 'Dockerfile'), 'utf8');
    const sources = JSON.parse(await readFile(path.join(root, 'container', 'update-sources.json'), 'utf8')) as {
      dockerfile: Array<{ arg: string }>;
    };
    const versionArgs = new Set([...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+_VERSION)=/gm)].map((match) => match[1]));
    expect(new Set(sources.dockerfile.map((entry) => entry.arg))).toEqual(versionArgs);

    const dockerPnpm = dockerfile.match(/^ARG PNPM_VERSION=([^\s]+)$/m)?.[1];
    const packageManager = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).packageManager;
    expect(packageManager).toBe(`pnpm@${dockerPnpm}`);
    const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    const containerRunner = await readFile(path.join(root, 'src', 'container-runner.ts'), 'utf8');
    const cliInstaller = await readFile(path.join(root, 'container', 'install-cli-tools.sh'), 'utf8');
    expect(workspace).toMatch(/^minimumReleaseAge:\s*0$/m);
    expect(workspace).toMatch(/^allowBuilds:$/m);
    expect(workspace).not.toMatch(/^onlyBuiltDependencies:/m);
    expect(dockerfile).toContain('pnpm config set --global --json allowBuilds');
    expect(dockerfile).toContain('only-built-dependencies[]=agent-browser');
    expect(containerRunner).toContain('pnpm config set --global --json allowBuilds');
    expect(containerRunner).toContain('only-built-dependencies[]=');
    expect(cliInstaller).toContain('pnpm config set --global --json allowBuilds');
    expect(cliInstaller).toContain('only-built-dependencies[]=');
    expect(dockerfile).not.toMatch(/pip install[^\n]*--upgrade pip setuptools wheel/);
    expect(dockerfile).not.toMatch(/pip install[^\n]*--no-cache-dir uv(?:\s|\\)/);
  });
});

describe('plugin version surface', () => {
  it('reports a manifest-version bump as outdated and refuses to auto-apply it', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const sources = JSON.parse(await readFile(path.join(root, 'container', 'update-sources.json'), 'utf8')) as {
      plugins?: Array<{ id: string; dir: string; repo: string; manifestPath: string }>;
    };
    const entry = sources.plugins?.[0];
    expect(entry).toBeDefined();

    // Local clone must exist where the audit looks for it, or the check is a silent no-op.
    const localManifest = path.join(homedir(), 'plugins', entry!.dir, '.claude-plugin', 'plugin.json');
    const local = JSON.parse(await readFile(localManifest, 'utf8')) as { version: string };
    expect(typeof local.version).toBe('string');

    const items = await auditRepository(root, async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) {
        expect(url).toContain(`${entry!.repo}/main/${entry!.manifestPath}`);
        return { version: '99.0.0' };
      }
      throw new Error('network blocked in test');
    });
    const item = items.find((candidate) => candidate.id === `plugin:${entry!.id}`);
    expect(item).toMatchObject({
      kind: 'plugin-version',
      surface: 'plugins',
      current: local.version,
      latest: '99.0.0',
      status: 'outdated',
    });

    // Plugin clones update via `git pull`, never by rewriting a manifest in this repo.
    await expect(applySelectedUpdates({ repoRoot: root, items, selectedIds: [`plugin:${entry!.id}`] })).rejects.toThrow(
      /git pull/,
    );
  });
});
