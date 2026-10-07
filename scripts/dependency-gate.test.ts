import { describe, expect, it } from 'vitest';

import type { DependencyPathRegistry as Registry } from '../src/dependency-paths.js';
import {
  changeProblems,
  directDependencies,
  effectiveLivePaths,
  lockedVersions,
  packageChanges,
  parseLedgers,
  patchedPackage,
  registryProblems,
  weakenedRegistryProblems,
  type DependencyFiles,
  type PackageChange,
} from './dependency-gate.js';

const pnpmLock = (patchHash = 'aaa', wsVersion = '8.21.0'): string => `lockfileVersion: '9.0'

patchedDependencies:
  '@chat-adapter/discord@4.41.1':
    hash: ${patchHash}
    path: patches/@chat-adapter__discord@4.41.1.patch

importers:
  .:
    dependencies:
      chat:
        specifier: 4.41.1
        version: 4.41.1

packages:

  '@chat-adapter/discord@4.41.1':
    resolution: {integrity: sha512-x}

  chat@4.41.1:
    resolution: {integrity: sha512-x}

  discord.js@14.27.0:
    resolution: {integrity: sha512-x}

  ws@${wsVersion}:
    resolution: {integrity: sha512-x}

  gitdep@git+ssh://git@github.com/example/gitdep.git#abc:
    resolution: {commit: abc}

snapshots:

  '@chat-adapter/discord@4.41.1(zod@4.6.5)':
    dependencies:
      discord.js: 14.27.0

  chat@4.41.1: {}

  discord.js@14.27.0:
    dependencies:
      ws: ${wsVersion}

  ws@${wsVersion}: {}
`;

const BUN_LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.290", "", { "dependencies": { "zod": "^4" } }, "sha512-x"],
    "zod": ["zod@4.6.5", "", {}, "sha512-x"],
  },
}
`;

const files = (overrides: Partial<DependencyFiles> = {}): DependencyFiles => ({
  hostPackageJson: JSON.stringify({ dependencies: { chat: '4.41.1' }, devDependencies: { ws: '8.21.0' } }),
  pnpmLock: pnpmLock(),
  runnerPackageJson: JSON.stringify({ dependencies: { zod: '^4.6.5' } }),
  bunLock: BUN_LOCK,
  remotionPackageJson: null,
  remotionLock: null,
  dockerfile: 'FROM node:22-slim\nARG CLAUDE_CODE_VERSION="2.1.290" # pinned\nARG BUN_VERSION=1.4.2\n',
  updateSources: JSON.stringify({
    dockerfile: [
      { id: 'claude-code', arg: 'CLAUDE_CODE_VERSION' },
      { id: 'bun', arg: 'BUN_VERSION' },
    ],
  }),
  ...overrides,
});

const registry: Registry = {
  livePaths: {
    'chat-inbound': { description: 'chat events reaching the router', tests: ['src/channels/chat-live-path.test.ts'] },
    'discord-inbound': { description: 'Discord events reaching the router', tests: [] },
    'provider-claude': { description: 'agent turns through Claude', tests: [] },
  },
  packages: {
    chat: { kind: 'live', paths: ['chat-inbound'] },
    '@chat-adapter/discord': { kind: 'live', paths: ['discord-inbound'] },
    'docker:claude-code': { kind: 'live', paths: ['provider-claude'] },
    'docker:bun': { kind: 'runtime' },
    'docker:base-image': { kind: 'runtime' },
    zod: { kind: 'runtime' },
    ws: { kind: 'dev' },
  },
};

const existing = new Set(['src/channels/chat-live-path.test.ts', 'src/router.test.ts', 'package.json']);
const exists = (file: string): boolean => existing.has(file);
const head = lockedVersions(files());
const live = effectiveLivePaths(registry, head.dependsOn);
const ledgerOf = (text: string) => parseLedgers([{ file: 'docs/dependency-changes/2026-10-07-x.md', text }]);
const gate = (changes: PackageChange[], text = '') => changeProblems(registry, live, changes, ledgerOf(text), exists);
const bump = (name: string, from: string, to: string): PackageChange => ({ name, from, to });

describe('locked versions', () => {
  it('reads pnpm and bun.lock packages, Docker pins with quotes or comments, and the base image', () => {
    const versions = Object.fromEntries([...head.versions].map(([name, set]) => [name, [...set]]));
    expect(versions).toEqual({
      '@chat-adapter/discord': ['4.41.1'],
      chat: ['4.41.1'],
      'discord.js': ['14.27.0'],
      ws: ['8.21.0'],
      gitdep: ['git+ssh://git@github.com/example/gitdep.git#abc'],
      '@anthropic-ai/claude-agent-sdk': ['0.3.290'],
      zod: ['4.6.5'],
      'docker:claude-code': ['2.1.290'],
      'docker:bun': ['1.4.2'],
      'docker:base-image': ['node:22-slim'],
    });
  });

  it('names direct dependencies from every manifest, every Docker pin and the base image', () => {
    expect([...directDependencies(files())].sort()).toEqual([
      'chat',
      'docker:base-image',
      'docker:bun',
      'docker:claude-code',
      'ws',
      'zod',
    ]);
  });

  it('reports a changed patch, by lockfile hash or by file, as a change at the same version', () => {
    expect(patchedPackage('patches/@chat-adapter__discord@4.41.1.patch')).toBe('@chat-adapter/discord');
    expect(patchedPackage('docs/patches.md')).toBeNull();
    const repatched = lockedVersions(files({ pnpmLock: pnpmLock('bbb') }));
    expect(packageChanges(head, repatched)).toEqual([bump('@chat-adapter/discord', '4.41.1', '4.41.1')]);
    expect(packageChanges(head, head, ['@chat-adapter/discord'])).toEqual([
      bump('@chat-adapter/discord', '4.41.1', '4.41.1'),
    ]);
  });
});

describe('live paths', () => {
  it('passes a live package’s paths to everything it depends on, a dev package included', () => {
    expect([...(live.get('discord.js') ?? [])]).toEqual(['discord-inbound']);
    expect([...(live.get('ws') ?? [])]).toEqual(['discord-inbound']);
    expect(live.get('zod')).toBeUndefined();
  });

  it('blocks a transitive move under a live package whose path has no test', () => {
    const moved = lockedVersions(files({ pnpmLock: pnpmLock('aaa', '8.22.0') }));
    const result = gate(packageChanges(head, moved));
    expect(result.problems).toEqual([
      expect.stringContaining('ws 8.21.0 → 8.22.0 is on live I/O path(s) with no real-library test: discord-inbound'),
      expect.stringContaining(
        'no docs/dependency-changes/ file this change adds or edits has a "## ws 8.21.0 → 8.22.0"',
      ),
    ]);
  });
});

describe('registry', () => {
  it('refuses an unclassified direct dependency and a live-path test CI would not run', () => {
    const problems = registryProblems(
      {
        livePaths: {
          'chat-inbound': { description: 'x', tests: ['src/channels/chat.test.ts', 'src/gone-live-path.test.ts'] },
        },
        packages: { chat: { kind: 'live', paths: ['chat-inbound', 'nowhere'] } },
      },
      new Set(['chat', 'zod']),
      exists,
    );
    expect(problems).toEqual([
      expect.stringContaining('zod is a direct dependency with no entry'),
      expect.stringContaining('chat names live path nowhere'),
      expect.stringContaining('src/channels/chat.test.ts; a live-path test\'s file name must contain "live-path"'),
      expect.stringContaining('src/gone-live-path.test.ts, which does not exist'),
    ]);
  });

  it('accepts a fully classified registry', () => {
    expect(registryProblems(registry, directDependencies(files()), exists)).toEqual([]);
  });

  it('refuses a weaker registry than the base unless a ledger explains it', () => {
    const weaker: Registry = {
      livePaths: { ...registry.livePaths, 'chat-inbound': { description: 'x', tests: [] } },
      packages: { ...registry.packages, chat: { kind: 'runtime' } },
    };
    expect(weakenedRegistryProblems(registry, weaker, ledgerOf(''))).toEqual([
      expect.stringContaining('chat no longer carries live path(s) chat-inbound'),
      expect.stringContaining('live path chat-inbound no longer lists src/channels/chat-live-path.test.ts'),
    ]);
    const explained = ledgerOf('Reclassified: chat · moved to a test\nReclassified: chat-inbound · test renamed\n');
    expect(weakenedRegistryProblems(registry, weaker, explained)).toEqual([]);
  });
});

describe('version changes', () => {
  it('blocks an upgrade on an untested live path, even with an Override line', () => {
    const text = '## docker:claude-code 2.1.290 → 2.1.300\nSource: x\nOverride: incident\n- none · not covered: n/a\n';
    const result = gate([bump('docker:claude-code', '2.1.290', '2.1.300')], text);
    expect(result.problems).toEqual([
      expect.stringContaining('docker:claude-code 2.1.290 → 2.1.300 is on live I/O path(s) with no real-library test'),
    ]);
  });

  it('lets an incident hotfix patch or a rollback through with an Override line, as a warning', () => {
    const ledger = [
      '## @chat-adapter/discord 4.41.1 → 4.41.1',
      'Source: patches/@chat-adapter__discord@4.41.1.patch',
      'Override: Discord inbound outage 2026-10-06, hotfix',
      '- snapshot the raw packet before the async forward · not covered: the Discord live-path test is not written yet',
      '',
      '## chat 4.41.1 → 4.29.0',
      'Source: rollback',
      '- returns to 4.29.0 · test: src/channels/chat-live-path.test.ts',
    ].join('\n');
    const result = gate([bump('@chat-adapter/discord', '4.41.1', '4.41.1'), bump('chat', '4.41.1', '4.29.0')], ledger);
    expect(result).toEqual({
      problems: [],
      warnings: [expect.stringContaining("Allowed by the ledger's Override: Discord inbound outage")],
    });
  });

  it('does not block removing a live package on its untested path, but still wants its ledger', () => {
    expect(gate([bump('@chat-adapter/discord', '4.41.1', 'none')]).problems).toEqual([
      expect.stringContaining('"## @chat-adapter/discord 4.41.1 → none" section'),
    ]);
  });

  it('requires a ledger section for a runtime or live change and nothing for a dev or unrelated change', () => {
    expect(gate([bump('chat', '4.29.0', '4.41.1'), bump('vitest', '5.0.2', '5.0.3')]).problems).toEqual([
      expect.stringContaining('"## chat 4.29.0 → 4.41.1" section'),
    ]);
  });

  it('accepts a CRLF ledger that maps every behaviour change to a test or a reason', () => {
    const text = [
      '# Chat SDK',
      '',
      '## chat 4.29.0 → 4.41.1',
      '',
      'Source: https://github.com/vercel/chat/releases',
      '',
      '- 4.41: undetected mentions report undefined instead of false · test: src/router.test.ts',
      '- 4.38: forwarded snapshots are folded into the message · not covered: no forwarded-message fixture yet',
    ].join('\r\n');
    expect(gate([bump('chat', '4.29.0', '4.41.1')], text)).toEqual({ problems: [], warnings: [] });
  });

  it('refuses wrong versions, no source, an unmapped entry, a non-test file and a missing test', () => {
    const text = [
      '## chat 4.29.0 → 4.40.0',
      '```',
      '# not a heading',
      '```',
      '- 4.41: async raw forward',
      '- 4.40: manifest · test: package.json',
      '- 4.39: thread parent lookup · test: src/channels/missing.test.ts',
    ].join('\n');
    expect(gate([bump('chat', '4.29.0', '4.41.1')], text).problems).toEqual([
      expect.stringContaining('the heading says 4.29.0 → 4.40.0, the lockfiles say 4.29.0 → 4.41.1'),
      expect.stringContaining('no "Source:" line'),
      expect.stringContaining('"4.41: async raw forward" ends in neither'),
      expect.stringContaining('cites package.json, which is not a test file'),
      expect.stringContaining('cites src/channels/missing.test.ts, which does not exist'),
    ]);
  });

  it('refuses a package explained in two ledgers, or a section with no entries', () => {
    const twice = parseLedgers([
      { file: 'docs/dependency-changes/a.md', text: '## zod 4.6.5 → 4.7.0\nSource: x\n' },
      { file: 'docs/dependency-changes/b.md', text: '## zod 4.6.5 → 4.7.0\nSource: x\n' },
    ]);
    expect(changeProblems(registry, live, [bump('zod', '4.6.5', '4.7.0')], twice, exists).problems).toEqual([
      'zod has a ledger section in both docs/dependency-changes/a.md and docs/dependency-changes/b.md',
      expect.stringContaining('no entries'),
    ]);
  });
});
