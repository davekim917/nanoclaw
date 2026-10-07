import { describe, expect, it } from 'vitest';

import type { DependencyPathRegistry as Registry } from '../src/dependency-paths.js';

import {
  changeProblems,
  directDependencies,
  lockedVersions,
  packageChanges,
  patchedPackage,
  registryProblems,
  type DependencyFiles,
} from './dependency-gate.js';

const PNPM_LOCK = `lockfileVersion: '9.0'

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

  ws@8.21.0:
    resolution: {integrity: sha512-x}

snapshots:

  chat@4.41.1(zod@4.6.5): {}
`;

const BUN_LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.290", "", {}, "sha512-x"],
    "zod": ["zod@4.6.5", "", {}, "sha512-x"],
  }
}
`;

const files = (overrides: Partial<DependencyFiles> = {}): DependencyFiles => ({
  hostPackageJson: JSON.stringify({ dependencies: { chat: '4.41.1' }, devDependencies: { vitest: '5.0.3' } }),
  pnpmLock: PNPM_LOCK,
  runnerPackageJson: JSON.stringify({ dependencies: { zod: '^4.6.5' } }),
  bunLock: BUN_LOCK,
  remotionPackageJson: null,
  remotionLock: null,
  dockerfile: 'FROM node:22\nARG CLAUDE_CODE_VERSION=2.1.290\nARG BUN_VERSION=1.4.2\n',
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
    'provider-claude': { description: 'agent turns through Claude', tests: [] },
  },
  packages: {
    chat: { kind: 'live', paths: ['chat-inbound'] },
    'docker:claude-code': { kind: 'live', paths: ['provider-claude'] },
    'docker:bun': { kind: 'runtime' },
    zod: { kind: 'runtime' },
    vitest: { kind: 'dev' },
  },
};

const existing = new Set(['src/channels/chat-live-path.test.ts', 'src/router.test.ts']);
const exists = (file: string): boolean => existing.has(file);

describe('locked versions', () => {
  it('reads pnpm packages, bun.lock packages and Docker pins, ignoring peer suffixes', () => {
    const versions = lockedVersions(files());
    expect(Object.fromEntries([...versions].map(([name, set]) => [name, [...set]]))).toEqual({
      '@chat-adapter/discord': ['4.41.1'],
      chat: ['4.41.1'],
      ws: ['8.21.0'],
      '@anthropic-ai/claude-agent-sdk': ['0.3.290'],
      zod: ['4.6.5'],
      'docker:claude-code': ['2.1.290'],
      'docker:bun': ['1.4.2'],
    });
  });

  it('names direct dependencies from both manifests and every Docker pin', () => {
    expect([...directDependencies(files())].sort()).toEqual([
      'chat',
      'docker:bun',
      'docker:claude-code',
      'vitest',
      'zod',
    ]);
  });

  it('reports a patch file change as a change to its package even at the same version', () => {
    expect(patchedPackage('patches/@chat-adapter__discord@4.41.1.patch')).toBe('@chat-adapter/discord');
    expect(patchedPackage('docs/patches.md')).toBeNull();
    const same = lockedVersions(files());
    expect(packageChanges(same, same, ['@chat-adapter/discord'])).toEqual([
      { name: '@chat-adapter/discord', from: '4.41.1', to: '4.41.1' },
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
});

describe('version changes', () => {
  const bump = (name: string, from: string, to: string) => ({ name, from, to });
  const ledger = (text: string) => [{ file: 'docs/dependency-changes/2026-10-07-chat.md', text }];

  it('blocks a change to a package on a live path that has no real-library test', () => {
    const problems = changeProblems(registry, [bump('docker:claude-code', '2.1.290', '2.1.300')], [], exists);
    expect(problems[0]).toContain(
      'docker:claude-code 2.1.290 → 2.1.300 is on live I/O path(s) with no real-library test: provider-claude',
    );
  });

  it('requires a ledger section for a runtime or live change and nothing for a dev change', () => {
    const problems = changeProblems(
      registry,
      [bump('chat', '4.29.0', '4.41.1'), bump('vitest', '5.0.2', '5.0.3'), bump('left-pad', '1.0.0', '1.0.1')],
      [],
      exists,
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'no docs/dependency-changes/ file this change adds or edits has a "## chat 4.29.0 → 4.41.1" section',
      ),
    ]);
  });

  it('accepts a ledger that maps every behaviour change to a test or a reason', () => {
    const text = [
      '# Chat SDK',
      '',
      '## chat 4.29.0 → 4.41.1',
      '',
      'Source: https://github.com/vercel/chat/releases',
      '',
      '- 4.41: undetected mentions report undefined instead of false · test: src/router.test.ts',
      '- 4.38: forwarded snapshots are folded into the message · not covered: no forwarded-message fixture yet',
    ].join('\n');
    expect(changeProblems(registry, [bump('chat', '4.29.0', '4.41.1')], ledger(text), exists)).toEqual([]);
  });

  it('refuses a ledger with the wrong versions, no source, an unmapped entry or a missing test', () => {
    const text = [
      '## chat 4.29.0 → 4.40.0',
      '- 4.41: async raw forward',
      '- 4.39: thread parent lookup · test: src/channels/missing.test.ts',
    ].join('\n');
    expect(changeProblems(registry, [bump('chat', '4.29.0', '4.41.1')], ledger(text), exists)).toEqual([
      expect.stringContaining('the heading says 4.29.0 → 4.40.0, the lockfiles say 4.29.0 → 4.41.1'),
      expect.stringContaining('no "Source:" line'),
      expect.stringContaining('"4.41: async raw forward" ends in neither'),
      expect.stringContaining('cites src/channels/missing.test.ts, which does not exist'),
    ]);
  });

  it('refuses a ledger section with no entries', () => {
    const text = '## zod 4.6.5 → 4.7.0\n\nSource: https://example.com/changelog\n';
    expect(changeProblems(registry, [bump('zod', '4.6.5', '4.7.0')], ledger(text), exists)).toEqual([
      expect.stringContaining('no entries'),
    ]);
  });
});
