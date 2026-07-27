import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { rmSync } from 'node:fs';

import {
  discoverSourcePath,
  discoverWorkgroup,
  isGraphifyDefaultExcludedPath,
  readVerifiedSource,
} from './discovery.js';

const { createReadStreamSpy } = vi.hoisted(() => ({ createReadStreamSpy: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      createReadStreamSpy(args[0]);
      return actual.createReadStream(...args);
    },
  };
});

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'graphify-discovery-'));
  roots.push(root);
  return root;
}

function put(root: string, relativePath: string, contents = 'knowledge'): string {
  const absolutePath = join(root, relativePath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents);
  return absolutePath;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  createReadStreamSpy.mockReset();
});

describe('discoverWorkgroup', () => {
  test('test_default_watcher_filter_prunes_package_build_and_tool_caches', () => {
    const root = '/workspace/group';
    for (const path of [
      'node_modules/pkg/index.js',
      '.pnpm-store/v10/files/aa/blob',
      'repo/.git/objects/pack',
      'repo/dist/app.js',
      'analysis/.cache/result.json',
      'python/.venv/lib/site.py',
      'python/sqlfluff-venv/lib/python3.11/site-packages/babel/locale-data/zu_ZA.dat',
      'python/.direnv/python-3.11/lib/site.py',
      'python/__pypackages__/3.11/lib/tool.py',
      'service/allure-results/run-result.json',
      'web/playwright-report/index.html',
      'web/test-results/screenshot.png',
    ]) {
      expect(isGraphifyDefaultExcludedPath(root, join(root, path))).toBe(true);
    }
    expect(isGraphifyDefaultExcludedPath(root, join(root, 'research', 'brief.md'))).toBe(false);
    expect(isGraphifyDefaultExcludedPath(root, join(root, '.notes', 'decision.md'))).toBe(false);
  });

  test('test_discovery_includes_gitignored_and_untracked_clone_files', async () => {
    const root = makeRoot();
    put(root, 'repos/analytics/.git/HEAD', 'ref: refs/heads/main');
    put(root, 'repos/analytics/.gitignore', 'ignored.sql\n');
    put(root, 'repos/analytics/models/tracked.sql', 'select 1');
    put(root, 'repos/analytics/ignored.sql', 'select 2');
    put(root, 'repos/analytics/notes/untracked.md', '# Finding');

    const sources = await discoverWorkgroup({ workgroupId: 'example-retail', root });
    const paths = sources.map((source) => source.relativePath);

    expect(paths).toContain('repos/analytics/models/tracked.sql');
    expect(paths).toContain('repos/analytics/ignored.sql');
    expect(paths).toContain('repos/analytics/notes/untracked.md');
    expect(paths.some((path) => path.startsWith('repos/analytics/.git/'))).toBe(false);
  });

  test('test_discovery_excludes_noise_but_not_hidden_knowledge', async () => {
    const root = makeRoot();
    put(root, 'node_modules/pkg/index.ts', 'noise');
    put(root, 'project/dist/bundle.js', 'noise');
    put(root, '.cache/copied.md', 'noise');
    put(root, '.research/strategy.md', '# Hidden but valuable');
    put(root, '.meeting-notes.md', '# Decision');

    const sources = await discoverWorkgroup({ workgroupId: 'wg', root });
    const paths = sources.map((source) => source.relativePath);

    expect(paths).toEqual(expect.arrayContaining(['.research/strategy.md', '.meeting-notes.md']));
    expect(paths).not.toEqual(
      expect.arrayContaining(['node_modules/pkg/index.ts', 'project/dist/bundle.js', '.cache/copied.md']),
    );
  });

  test('test_discovery_excludes_named_python_virtualenvs', async () => {
    const root = makeRoot();
    put(root, 'sqlfluff-venv/lib/python3.11/site-packages/babel/messages/catalog.py', 'noise');
    put(root, 'project/.direnv/python-3.11/lib/python/site.py', 'noise');
    put(root, 'project/__pypackages__/3.11/lib/tool.py', 'noise');
    put(root, 'research/environment-notes.md', '# Valuable knowledge');

    const sources = await discoverWorkgroup({ workgroupId: 'wg', root });

    expect(sources.map((source) => source.relativePath)).toEqual(['research/environment-notes.md']);
  });

  test('test_discovery_never_follows_symlink_escape', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    put(outside, 'secret.md', '# Outside');
    mkdirSync(join(root, 'links'), { recursive: true });
    symlinkSync(outside, join(root, 'links/outside'));
    symlinkSync(join(outside, 'secret.md'), join(root, 'linked-secret.md'));
    put(root, 'inside.md', '# Inside');

    const sources = await discoverWorkgroup({ workgroupId: 'wg', root });

    expect(sources.map((source) => source.relativePath)).toEqual(['inside.md']);
  });

  test('test_discovery_credentials_are_metadata_only', async () => {
    const root = makeRoot();
    put(root, '.env.production', 'API_KEY=super-secret');
    put(root, 'keys/service-account-prod.json', '{"private_key":"secret"}');
    put(root, 'keys/cert.pem', '-----BEGIN PRIVATE KEY-----\nsecret');

    const sources = await discoverWorkgroup({ workgroupId: 'wg', root });

    expect(sources).toHaveLength(3);
    for (const source of sources) {
      expect(source.state).toBe('metadata_only');
      expect(source.stateReason).toMatch(/credential|sensitive/i);
    }
  });

  test('test_discovery_oversized_sources_are_visible', async () => {
    const root = makeRoot();
    const largePath = put(root, 'large.md', '');
    truncateSync(largePath, 10 * 1024 * 1024 + 1);

    const sources = await discoverWorkgroup({ workgroupId: 'wg', root });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      relativePath: 'large.md',
      state: 'metadata_only',
      bytes: 10 * 1024 * 1024 + 1,
    });
    expect(sources[0].stateReason).toMatch(/10 MiB/i);
    expect(sources[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('test_discovery_metadata_only_never_reads_content', async () => {
    const root = makeRoot();
    put(root, '.env.production', 'API_KEY=super-secret');
    const largePath = put(root, 'large.md', '');
    truncateSync(largePath, 10 * 1024 * 1024 + 1);
    put(root, 'normal.md', '# Read and hash this content');
    createReadStreamSpy.mockClear();

    const sources = await discoverWorkgroup({ workgroupId: 'wg', root });

    expect(sources.map((source) => [source.relativePath, source.state])).toEqual([
      ['.env.production', 'metadata_only'],
      ['large.md', 'metadata_only'],
      ['normal.md', 'pending'],
    ]);
    expect(createReadStreamSpy.mock.calls.map(([path]) => path)).toEqual([join(root, 'normal.md')]);
  });

  test('test_graphifyignore_is_opt_out_only', async () => {
    const root = makeRoot();
    put(
      root,
      '.graphifyignore',
      ['# explicit operator opt-outs', 'private/decision.md', 'scratch/', '**/*.generated.sql', 'exports/*.csv'].join(
        '\n',
      ),
    );
    put(root, 'private/decision.md', 'omit');
    put(root, 'scratch/note.md', 'omit');
    put(root, 'models/orders.generated.sql', 'omit');
    put(root, 'exports/report.csv', 'omit');
    put(root, 'models/orders.sql', 'keep');
    put(root, 'unlisted/strategy.md', 'keep');

    const sources = await discoverWorkgroup({ workgroupId: 'wg', root });

    expect(sources.map((source) => source.relativePath)).toEqual(['models/orders.sql', 'unlisted/strategy.md']);
  });

  test('test_single_source_discovery_matches_full_policy_and_reports_absence', async () => {
    const root = makeRoot();
    const sourcePath = put(root, 'notes/decision.md', '# Immediate knowledge');
    const [full] = await discoverWorkgroup({ workgroupId: 'wg', root });

    await expect(discoverSourcePath({ workgroupId: 'wg', root, path: sourcePath })).resolves.toEqual(full);

    put(root, '.graphifyignore', 'notes/decision.md\n');
    await expect(discoverSourcePath({ workgroupId: 'wg', root, path: sourcePath })).resolves.toBeUndefined();

    rmSync(sourcePath);
    await expect(discoverSourcePath({ workgroupId: 'wg', root, path: sourcePath })).resolves.toBeUndefined();
    await expect(discoverSourcePath({ workgroupId: 'wg', root, path: join(makeRoot(), 'outside.md') })).rejects.toThrow(
      /outside/,
    );
  });

  test('test_discovery_aborts_an_active_hash_when_interactive_work_arrives', async () => {
    const root = makeRoot();
    put(root, 'first.md', '# first');
    put(root, 'second.md', '# second');
    const controller = new AbortController();
    createReadStreamSpy.mockImplementationOnce(() => {
      controller.abort('interactive chat pressure');
    });

    await expect(discoverWorkgroup({ workgroupId: 'wg', root, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
      message: 'interactive chat pressure',
    });
    expect(createReadStreamSpy).toHaveBeenCalledTimes(1);
  });

  test('verified extraction rejects same-size changes and replacement symlinks', async () => {
    const root = makeRoot();
    const sourcePath = put(root, 'decision.md', 'approved');
    const [source] = await discoverWorkgroup({ workgroupId: 'wg', root });

    writeFileSync(sourcePath, 'rejected');
    await expect(readVerifiedSource(source, 1024)).rejects.toThrow(/changed after discovery/);

    rmSync(sourcePath);
    const outside = put(makeRoot(), 'other.md', 'approved');
    symlinkSync(outside, sourcePath);
    await expect(readVerifiedSource(source, 1024)).rejects.toThrow();
  });
});
