import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applySelectedUpdates,
  auditRepository,
  buildScheduledAuditGate,
  CONTAINER_PLUGINS_ROOT,
  describeUpstreamPolicy,
  latestStableGitHubRelease,
  latestStableGitHubTag,
  latestStableNpmVersion,
  latestStablePyPiVersion,
  readUpstreamPolicy,
  renderAuditMarkdown,
  deriveUpstreamPolicy,
  LOCAL_SERVICE_PAIRS,
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
  it('reports a manifest-version bump as outdated and refuses to auto-apply it', async (ctx) => {
    const root = path.resolve(import.meta.dirname, '..');
    const sources = JSON.parse(await readFile(path.join(root, 'container', 'update-sources.json'), 'utf8')) as {
      plugins?: Array<{ id: string; dir: string; repo: string; manifestPath: string; manifestDir?: string }>;
    };
    const entry = sources.plugins?.[0];
    expect(entry).toBeDefined();

    // Resolve the clone exactly as auditRepository does: container mount first, then
    // the host clone, honouring `manifestDir` (Codex-native plugins use .codex-plugin).
    // Checking only ~/plugins made this fail on every CI run, where neither exists.
    const localManifest = [CONTAINER_PLUGINS_ROOT, path.join(homedir(), 'plugins')]
      .map((pluginsRoot) => path.join(pluginsRoot, entry!.dir, entry!.manifestDir ?? '.claude-plugin', 'plugin.json'))
      .find((candidate) => existsSync(candidate));

    // No clone anywhere means a CI runner, where this check cannot say anything. Skip
    // rather than fail; where a clone IS present every assertion below still hard-fails.
    if (!localManifest) ctx.skip();

    const local = JSON.parse(await readFile(localManifest!, 'utf8')) as { version: string };
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

describe('upstream policy — the gates that #135 slipped past', () => {
  const manifest = (deps: Record<string, string>): string => JSON.stringify({ dependencies: deps });

  it('flags a dependency the last upstream merge resolved KEEP-OURS', () => {
    // The real shape of merge ceb3fcd1: ours ^0.5.0, upstream 2.2.1, result ^0.5.0.
    const policy = deriveUpstreamPolicy({
      upstream: manifest({ '@onecli-sh/sdk': '2.2.1' }),
      mergeOurs: manifest({ '@onecli-sh/sdk': '^0.5.0' }),
      mergeTheirs: manifest({ '@onecli-sh/sdk': '2.2.1' }),
      mergeResult: manifest({ '@onecli-sh/sdk': '^0.5.0' }),
    });
    expect(policy.get('@onecli-sh/sdk')).toEqual({ upstreamPin: '2.2.1', keptOurs: true });
  });

  it('does NOT claim keep-ours when the merge adopted upstream', () => {
    const policy = deriveUpstreamPolicy({
      upstream: manifest({ chalk: '5.4.0' }),
      mergeOurs: manifest({ chalk: '5.3.0' }),
      mergeTheirs: manifest({ chalk: '5.4.0' }),
      mergeResult: manifest({ chalk: '5.4.0' }),
    });
    expect(policy.get('chalk')?.keptOurs).toBeUndefined();
    expect(policy.get('chalk')?.upstreamPin).toBe('5.4.0');
  });

  it('does NOT claim keep-ours when both sides already agreed (no decision was made)', () => {
    const policy = deriveUpstreamPolicy({
      upstream: manifest({ zod: '3.24.1' }),
      mergeOurs: manifest({ zod: '3.24.1' }),
      mergeTheirs: manifest({ zod: '3.24.1' }),
      mergeResult: manifest({ zod: '3.24.1' }),
    });
    expect(policy.get('zod')?.keptOurs).toBeUndefined();
  });

  it('reports an upstream pin even when no merge history is available', () => {
    const policy = deriveUpstreamPolicy({ upstream: manifest({ undici: '6.24.1' }) });
    expect(policy.get('undici')).toEqual({ upstreamPin: '6.24.1' });
  });

  it('fails open on unreadable or absent manifests instead of throwing', () => {
    expect(deriveUpstreamPolicy({ upstream: 'not json', mergeResult: null }).size).toBe(0);
    expect(deriveUpstreamPolicy({}).size).toBe(0);
  });

  it('covers devDependencies, not just dependencies', () => {
    const policy = deriveUpstreamPolicy({
      upstream: JSON.stringify({ devDependencies: { vitest: '4.1.0' } }),
    });
    expect(policy.get('vitest')?.upstreamPin).toBe('4.1.0');
  });

  it('declares the OneCLI SDK as paired with a local service', () => {
    expect(LOCAL_SERVICE_PAIRS['@onecli-sh/sdk']).toMatch(/gateway/i);
  });
});

describe('upstream policy snapshot fallback (containers have no .git)', () => {
  const writeSnapshot = (root: string, body: unknown) =>
    writeFile(path.join(root, '.upstream-policy.json'), JSON.stringify(body));

  it('falls back to a valid, fresh snapshot when git yields nothing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upstream-policy-'));
    await writeSnapshot(root, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      manifests: { 'package.json': { undici: { upstreamPin: '6.24.1', keptOurs: true } } },
    });
    const policy = await readUpstreamPolicy(root, 'package.json');
    expect(policy.get('undici')).toEqual({ upstreamPin: '6.24.1', keptOurs: true });
  });

  it('ignores a snapshot older than 14 days and fails open to an empty map', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upstream-policy-'));
    const stale = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    await writeSnapshot(root, {
      schemaVersion: 1,
      generatedAt: stale,
      manifests: { 'package.json': { undici: { upstreamPin: '6.24.1' } } },
    });
    const policy = await readUpstreamPolicy(root, 'package.json');
    expect(policy.size).toBe(0);
  });

  it('ignores a malformed snapshot and fails open to an empty map', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upstream-policy-'));
    await writeFile(path.join(root, '.upstream-policy.json'), 'not json');
    const policy = await readUpstreamPolicy(root, 'package.json');
    expect(policy.size).toBe(0);
  });

  it('ignores a snapshot with the wrong schemaVersion and fails open to an empty map', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upstream-policy-'));
    await writeSnapshot(root, {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      manifests: { 'package.json': { undici: { upstreamPin: '6.24.1' } } },
    });
    const policy = await readUpstreamPolicy(root, 'package.json');
    expect(policy.size).toBe(0);
  });

  it('describeUpstreamPolicy reports git when upstream/main resolves in repoRoot', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    expect(await describeUpstreamPolicy(root)).toEqual({ source: 'git', generatedAt: null });
  });

  it('describeUpstreamPolicy reports snapshot with its generatedAt when repoRoot has no git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upstream-policy-'));
    const generatedAt = new Date().toISOString();
    await writeSnapshot(root, { schemaVersion: 1, generatedAt, manifests: {} });
    expect(await describeUpstreamPolicy(root)).toEqual({ source: 'snapshot', generatedAt });
  });

  it('describeUpstreamPolicy reports unavailable when there is neither git nor a snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upstream-policy-'));
    expect(await describeUpstreamPolicy(root)).toEqual({ source: 'unavailable', generatedAt: null });
  });

  // The predicate this whole feature exists for: gating the fallback on
  // "upstream/main resolved", NOT on "the derived map is non-empty". A repo
  // with full merge history but no `upstream` remote (exactly what a plain
  // `git clone` of this repo produces) still lets `git log --merges --grep=`
  // find the upstream-merge commit and derive `heldByMerge` from its parents
  // — a NON-EMPTY map that is missing `upstreamPin` on every entry, because
  // computing `upstreamPin` requires `upstream/main` itself to resolve. The
  // old `policy.size > 0` predicate would keep that half-signal and never
  // reach the snapshot. This fixture builds exactly that repo shape.
  it('prefers the snapshot over a git-reachable-but-incomplete merge signal (no upstream remote)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upstream-policy-git-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);

    const manifestPath = path.join(root, 'package.json');
    await writeFile(manifestPath, JSON.stringify({ dependencies: { mypkg: '1.0.0' } }));
    git(['add', 'package.json']);
    git(['commit', '-q', '-m', 'base']);

    git(['checkout', '-q', '-b', 'feature']);
    await writeFile(manifestPath, JSON.stringify({ dependencies: { mypkg: '2.0.0' } }));
    git(['commit', '-q', '-am', 'feature bump']);

    git(['checkout', '-q', 'main']);
    await writeFile(manifestPath, JSON.stringify({ dependencies: { mypkg: '1.5.0' } }));
    git(['commit', '-q', '-am', 'main bump']);

    // -X ours auto-resolves the conflict keeping main's side; the message is
    // exactly what readUpstreamPolicyFromGit's --grep matches to find this
    // commit (mirrors the real message `git merge upstream/main` produces).
    // NO `upstream` remote is ever added — `upstream/main` can never resolve.
    git(['merge', '-q', '--no-ff', '-X', 'ours', '-m', "Merge remote-tracking branch 'upstream/main'", 'feature']);

    // A snapshot carrying an upstreamPin the git path above cannot produce
    // (it has no upstream/main to read one from).
    await writeSnapshot(root, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      manifests: { 'package.json': { mypkg: { upstreamPin: '9.9.9', keptOurs: true } } },
    });

    const originalEnv = process.env.NANOCLAW_UPSTREAM_POLICY;
    process.env.NANOCLAW_UPSTREAM_POLICY = path.join(root, '.upstream-policy.json');
    try {
      const policy = await readUpstreamPolicy(root, 'package.json');
      expect(policy.get('mypkg')?.upstreamPin).toBe('9.9.9');
      expect(await describeUpstreamPolicy(root)).toMatchObject({ source: 'snapshot' });
    } finally {
      if (originalEnv === undefined) delete process.env.NANOCLAW_UPSTREAM_POLICY;
      else process.env.NANOCLAW_UPSTREAM_POLICY = originalEnv;
    }
  });
});

describe('audit rendering surfaces the constraints', () => {
  const item = (over: Partial<AuditItem>): AuditItem => ({
    id: 'host:pkg',
    name: 'pkg',
    kind: 'host-dependency',
    surface: 'host',
    current: '1.0.0',
    latest: '2.0.0',
    status: 'outdated',
    source: 'npm',
    ...over,
  });

  it('renders a HELD warning naming both pins', () => {
    const md = renderAuditMarkdown([
      item({
        id: 'host:@onecli-sh/sdk',
        name: '@onecli-sh/sdk',
        current: '^0.5.0',
        upstreamPin: '2.2.1',
        heldByMerge: true,
      }),
    ]);
    expect(md).toContain('HELD by the last upstream merge');
    expect(md).toContain('^0.5.0');
    expect(md).toContain('2.2.1');
  });

  it('reports upstream drift separately from held items', () => {
    const md = renderAuditMarkdown([item({ upstreamPin: '1.5.0' })]);
    expect(md).toContain('Upstream pins differ');
    expect(md).toContain('upstream `1.5.0`');
    expect(md).not.toContain('HELD by the last upstream merge');
  });

  it('warns that client/server pairs cannot be validated by building', () => {
    const md = renderAuditMarkdown([item({ pairedWith: 'the OneCLI gateway container' })]);
    expect(md).toContain('CANNOT be validated by building');
  });

  it('stays quiet when an outdated item carries no constraints', () => {
    const md = renderAuditMarkdown([item({})]);
    expect(md).not.toContain('HELD by');
    expect(md).not.toContain('Upstream pins differ');
    expect(md).not.toContain('CANNOT be validated');
  });
});
