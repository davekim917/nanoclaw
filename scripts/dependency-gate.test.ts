import { describe, expect, it } from 'vitest';

import type { DependencyPathRegistry as Registry } from '../src/dependency-paths.js';
import {
  packageChanges,
  parseLedgers,
  patchedPackage,
  changeProblems,
  consumerMoves,
  type DependencyFiles,
  directDependencies,
  dockerfileProblems,
  liveAtEitherEnd,
  liveMoves,
  lockedVersions,
  type PackageChange,
  trackedTools,
  registryProblems,
  repatchedPackages,
  runtimeReach,
  weakenedRegistryProblems,
  withRepoints,
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
      '@types/ws': 8.18.1
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
    'slack-files': { description: 'Slack file downloads', tests: [] },
  },
  packages: {
    chat: { kind: 'live', paths: ['chat-inbound'] },
    '@chat-adapter/discord': { kind: 'live', paths: ['discord-inbound'] },
    'docker:claude-code': { kind: 'live', paths: ['provider-claude'] },
    '@slack/web-api': { kind: 'live', paths: ['slack-files'] },
    'docker:bun': { kind: 'runtime' },
    'docker:base-image': { kind: 'runtime' },
    zod: { kind: 'runtime' },
    ws: { kind: 'dev' },
  },
};

const contents: Record<string, string> = {
  'src/channels/chat-live-path.test.ts': "import { wire } from './chat-wiring.js';\nit('delivers', () => wire());\n",
  'src/channels/chat-wiring.ts': "import { Chat } from 'chat';\nexport const wire = () => new Chat();\n",
  'src/channels/placeholder-live-path.test.ts': "it('ok', () => {});\n",
  'src/channels/mocked-live-path.test.ts': "vi.mock('chat', () => ({}));\nimport 'chat';\nit('ok', () => {});\n",
  'src/channels/typed-live-path.test.ts': "import type { Chat } from 'chat';\nit('ok', () => {});\n",
  'src/channels/commented-live-path.test.ts': "// TODO: import { Chat } from 'chat';\nit('ok', () => {});\n",
  'src/channels/stringly-live-path.test.ts': "const s = \"import 'chat'\";\nit('ok', () => {});\n",
  'src/channels/host-mocked-live-path.test.ts':
    "vi.mock('./chat-wiring.js');\nimport { wire } from './chat-wiring.js';\nit('ok', () => wire());\n",
  'src/channels/dynamic-mocked-live-path.test.ts':
    "vi.mock(import('chat'), () => ({}));\nimport 'chat';\nit('ok', () => {});\n",
  'src/channels/template-mocked-live-path.test.ts':
    "vi.mock(`chat`, () => ({}));\nimport 'chat';\nit('ok', () => {});\n",
  'src/channels/helper-mocked-live-path.test.ts': "import './chat-fake.js';\nimport 'chat';\nit('ok', () => {});\n",
  'src/channels/chat-fake.ts': "vi.mock('chat', () => ({}));\n",
  'src/router.test.ts': '',
  'package.json': '{}',
};
const read = (file: string): string | null => contents[file] ?? null;
const exists = (file: string): boolean => read(file) !== null;
const head = lockedVersions(files());
const reach = runtimeReach(registry, head.dependsOn);
const ledgerOf = (text: string) => parseLedgers([{ file: 'docs/dependency-changes/2026-10-07-x.md', text }]);
/** A synthetic change to a live package moves that package's own closure. */
const selfMoves = (changes: PackageChange[], within: Registry) => {
  const moves = new Map<'host' | 'runner' | 'remotion' | 'docker', Map<string, Set<string>>>();
  for (const change of changes) {
    if (within.packages[change.name]?.kind !== 'live') continue;
    for (const source of change.sources) {
      const bySource = moves.get(source) ?? new Map<string, Set<string>>();
      bySource.set(change.name, new Set([change.name]));
      moves.set(source, bySource);
    }
  }
  return moves;
};
const gate = (changes: PackageChange[], text = '', within = registry, base: Registry | null = null) =>
  changeProblems(
    within,
    runtimeReach(within, head.dependsOn),
    changes,
    ledgerOf(text),
    exists,
    selfMoves(changes, within),
    base,
  );
const movesBetween = (before: ReturnType<typeof lockedVersions>, after: ReturnType<typeof lockedVersions>) => {
  const changes = packageChanges(before, after);
  return { changes, moves: liveMoves(registry, before, after, repatchedPackages(before, after)) };
};
const bump = (name: string, from: string, to: string, source: 'host' | 'docker' = 'host'): PackageChange => {
  const was = from === 'none' ? [] : from.split(',');
  const now = to === 'none' ? [] : to.split(',');
  return {
    name,
    from,
    to,
    sources: [source],
    added: now.filter((v) => !was.includes(v)),
    removed: was.filter((v) => !now.includes(v)),
  };
};

describe('locked versions', () => {
  it('reads pnpm and bun.lock packages, Docker pins with quotes or comments, and the base image', () => {
    const versions = Object.fromEntries(
      [...head.versions].map(([source, byName]) => [
        source,
        Object.fromEntries([...byName].map(([name, set]) => [name, [...set]])),
      ]),
    );
    expect(versions).toEqual({
      host: {
        '@chat-adapter/discord': ['4.41.1'],
        chat: ['4.41.1'],
        'discord.js': ['14.27.0'],
        ws: ['8.21.0'],
        gitdep: ['git+ssh://git@github.com/example/gitdep.git#abc'],
      },
      runner: { '@anthropic-ai/claude-agent-sdk': ['0.3.290'], zod: ['4.6.5'] },
      docker: { 'docker:claude-code': ['2.1.290'], 'docker:bun': ['1.4.2'], 'docker:base-image': ['node:22-slim'] },
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
    expect(patchedPackage('patches/@chat-adapter__discord@4.41.1.patch')).toEqual({
      name: '@chat-adapter/discord',
      source: 'host',
    });
    expect(patchedPackage('docs/patches.md')).toBeNull();
    const repatched = lockedVersions(files({ pnpmLock: pnpmLock('bbb') }));
    expect(packageChanges(head, repatched)).toEqual([bump('@chat-adapter/discord', '4.41.1', '4.41.1')]);
    expect(packageChanges(head, head, [{ name: '@chat-adapter/discord', source: 'host' }])).toEqual([
      bump('@chat-adapter/discord', '4.41.1', '4.41.1'),
    ]);
    expect(patchedPackage('patches/@scope__unversioned.patch')).toEqual({ name: '@scope/unversioned', source: 'host' });
  });

  it('reports a changed agent-runner patch, by file or by bun.lock entry, in the runner tree', () => {
    expect(patchedPackage('container/agent-runner/patches/@anthropic-ai__claude-agent-sdk@0.3.290.patch')).toEqual({
      name: '@anthropic-ai/claude-agent-sdk',
      source: 'runner',
    });
    const patched = lockedVersions(
      files({
        bunLock: BUN_LOCK.replace(
          '"lockfileVersion": 1,',
          '"lockfileVersion": 1,\n  "patchedDependencies": { "@anthropic-ai/claude-agent-sdk@0.3.290": "patches/sdk.patch" },',
        ),
      }),
    );
    expect(packageChanges(head, patched)).toEqual([
      { ...bump('@anthropic-ai/claude-agent-sdk', '0.3.290', '0.3.290'), sources: ['runner'] },
    ]);
  });
});

describe('runtime reach and live paths', () => {
  it('reaches registered non-dev packages and what they load in the same tree, not type-only packages', () => {
    const host = reach.get('host')!;
    expect(host.has('discord.js')).toBe(true);
    expect(host.has('ws')).toBe(true);
    expect(host.has('@types/ws')).toBe(false);
    expect(reach.get('remotion')?.has('ws')).toBe(false);
  });

  it('judges a move in one lockfile by that tree alone', () => {
    const remotionLock = (ws: string) =>
      `lockfileVersion: '9.0'\n\npackages:\n\n  ws@${ws}:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n  ws@${ws}: {}\n`;
    const before = lockedVersions(files({ remotionLock: remotionLock('8.20.0') }));
    const after = lockedVersions(files({ remotionLock: remotionLock('8.21.0') }));
    const changes = packageChanges(before, after);
    expect(changes).toEqual([
      expect.objectContaining({ name: 'ws', sources: ['remotion'], added: ['8.21.0'], removed: ['8.20.0'] }),
    ]);
    expect(changeProblems(registry, reach, changes, ledgerOf(''), exists, new Map()).problems).toEqual([]);
  });

  it('blocks an exact-version move beneath a live package whose path has no test', () => {
    const { changes, moves } = movesBetween(head, lockedVersions(files({ pnpmLock: pnpmLock('aaa', '8.22.0') })));
    expect(changeProblems(registry, reach, changes, ledgerOf(''), exists, moves).problems).toEqual([
      expect.stringContaining(
        'ws 8.21.0 → 8.22.0 (loaded by @chat-adapter/discord) is on live I/O path(s) with no real-library test: discord-inbound',
      ),
    ]);
  });

  it('does not block a version of the same name that only something else loads', () => {
    const withOther = (otherWs: string) =>
      pnpmLock()
        .replace(
          'packages:\n',
          `packages:\n\n  other@1.0.0:\n    resolution: {integrity: sha512-x}\n\n  ws@${otherWs}:\n    resolution: {integrity: sha512-x}\n`,
        )
        .replace(
          'snapshots:\n',
          `snapshots:\n\n  other@1.0.0:\n    dependencies:\n      ws: ${otherWs}\n\n  ws@${otherWs}: {}\n`,
        );
    const before = lockedVersions(files({ pnpmLock: withOther('7.0.0') }));
    const after = lockedVersions(files({ pnpmLock: withOther('7.1.0') }));
    const { changes, moves } = movesBetween(before, after);
    expect(changes.map((c) => `${c.name} ${c.from} → ${c.to}`)).toEqual(['ws 7.0.0,8.21.0 → 7.1.0,8.21.0']);
    expect(moves.get('host')?.has('ws')).toBeFalsy();
  });

  it('follows bun.lock nested keys to the copy a live package actually loads', () => {
    const bun = (nested: string, top: string) => `{
  "lockfileVersion": 1,
  "packages": {
    "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.290", "", { "dependencies": { "zod": "^3" } }, "sha512-x"],
    "@anthropic-ai/claude-agent-sdk/zod": ["zod@${nested}", "", {}, "sha512-x"],
    "zod": ["zod@${top}", "", {}, "sha512-x"],
  },
}
`;
    const live: Registry = {
      ...registry,
      packages: {
        ...registry.packages,
        '@anthropic-ai/claude-agent-sdk': { kind: 'live', paths: ['provider-claude'] },
      },
    };
    const moves = (a: string, b: string) =>
      liveMoves(live, lockedVersions(files({ bunLock: a })), lockedVersions(files({ bunLock: b })), new Map());
    expect(moves(bun('3.25.0', '4.6.5'), bun('3.26.0', '4.6.5')).get('runner')?.get('zod')).toEqual(
      new Set(['@anthropic-ai/claude-agent-sdk']),
    );
    expect(moves(bun('3.25.0', '4.6.5'), bun('3.25.0', '4.7.0')).get('runner')?.has('zod')).toBeFalsy();
  });

  it('counts a live path tested only if the base registry already listed its test', () => {
    const listedNow: Registry = {
      ...registry,
      livePaths: {
        ...registry.livePaths,
        'discord-inbound': { description: 'x', tests: ['src/channels/chat-live-path.test.ts'] },
      },
    };
    const change = [bump('@chat-adapter/discord', '4.41.1', '4.42.0')];
    const text = '## @chat-adapter/discord 4.41.1 → 4.42.0\nSource: x\n- y · not covered: z\n';
    expect(gate(change, text, listedNow, registry).problems).toEqual([
      expect.stringContaining('is on live I/O path(s) with no real-library test: discord-inbound'),
    ]);
    expect(gate(change, text, listedNow, listedNow).problems).toEqual([]);
  });

  it.each([
    ['a major move', '3.7.2', '4.0.0', true],
    ['a 0.x minor move', '0.3.1', '0.4.0', true],
    ['a new release line beside the old', '3.7.2', '3.7.2,4.0.0', true],
    ['a move inside its range', '3.7.2', '3.8.0', false],
  ])('wants a ledger for a transitive package under a runtime one on %s', (_label, from, to, wanted) => {
    const graph = new Map([['host' as const, new Map([['zod', new Set(['luxon'])]])]]);
    const problems = changeProblems(
      registry,
      runtimeReach(registry, graph),
      [bump('luxon', from, to)],
      ledgerOf(''),
      exists,
      new Map(),
    ).problems;
    expect(problems).toEqual(wanted ? [expect.stringContaining(`"## luxon ${from} → ${to}" section`)] : []);
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
      read,
    );
    expect(problems).toEqual([
      expect.stringContaining('zod is a direct dependency with no entry'),
      expect.stringContaining('chat names live path nowhere'),
      expect.stringContaining('src/channels/chat.test.ts; a live-path test\'s file name must contain "live-path"'),
      expect.stringContaining('src/gone-live-path.test.ts, which does not exist'),
    ]);
  });

  it('accepts a fully classified registry whose live-path test loads its package through a host module', () => {
    expect(registryProblems(registry, directDependencies(files()), read)).toEqual([]);
  });

  it.each([
    ['imports nothing', 'src/channels/placeholder-live-path.test.ts'],
    ['mocks the package it imports', 'src/channels/mocked-live-path.test.ts'],
    ['imports only its types', 'src/channels/typed-live-path.test.ts'],
    ['imports it only in a comment', 'src/channels/commented-live-path.test.ts'],
    ['imports it only inside a string', 'src/channels/stringly-live-path.test.ts'],
    ['mocks the host module it loads it through', 'src/channels/host-mocked-live-path.test.ts'],
    ['mocks it through import()', 'src/channels/dynamic-mocked-live-path.test.ts'],
    ['mocks it with a template literal', 'src/channels/template-mocked-live-path.test.ts'],
    ['mocks it in a helper module it imports', 'src/channels/helper-mocked-live-path.test.ts'],
  ])('refuses a live-path test that %s', (_label, test) => {
    const placeholder: Registry = {
      ...registry,
      livePaths: { ...registry.livePaths, 'chat-inbound': { description: 'x', tests: [test] } },
    };
    expect(registryProblems(placeholder, directDependencies(files()), read)).toEqual([
      expect.stringContaining(`${test}, which loads none of the packages on that path (chat) at runtime`),
    ]);
  });

  it('refuses a live-path test whose package a vitest setup file mocks for every test', () => {
    const withSetup = (file: string): string | null =>
      file === 'vitest.config.ts'
        ? "export default { test: { setupFiles: ['src/test-setup.ts'] } };\n"
        : file === 'src/test-setup.ts'
          ? "vi.mock('chat', () => ({}));\n"
          : read(file);
    expect(registryProblems(registry, directDependencies(files()), withSetup)).toEqual([
      expect.stringContaining('src/channels/chat-live-path.test.ts, which loads none of the packages on that path'),
    ]);
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

  it.each([
    ['live to runtime', { kind: 'runtime' as const }],
    ['runtime to dev', { kind: 'dev' as const }],
  ])('refuses a %s reclassification in the same change as a version change, even explained', (_label, now) => {
    const name = now.kind === 'runtime' ? 'chat' : 'zod';
    const weaker: Registry = { ...registry, packages: { ...registry.packages, [name]: now } };
    const explained = ledgerOf(`Reclassified: ${name} · not really live\n`);
    expect(weakenedRegistryProblems(registry, weaker, explained, [bump(name, '1.0.0', '9.9.9')])).toEqual([
      expect.stringContaining(`${name} changes version in the same change that weakens its classification`),
    ]);
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

  it('lets an exact rollback of a pooled version set through, as the 4.41 Slack bump would need', () => {
    const text =
      '## @slack/web-api 7.19.0,8.2.0 → 7.15.1,8.2.0\nSource: rollback\nOverride: revert\n- returns to 7.15.1 · not covered: rollback\n';
    expect(gate([bump('@slack/web-api', '7.19.0,8.2.0', '7.15.1,8.2.0')], text)).toEqual({
      problems: [],
      warnings: [expect.stringContaining('Allowed by the ledger')],
    });
  });

  it.each([
    ['a git version', '4.41.1', 'github:vercel/chat#abc'],
    ['a version set whose oldest consumer moves up', '7.15.1,8.2.0', '7.19.0'],
    ['a prerelease', '4.41.1', '4.40.0-beta.1'],
    ['a dropped version whose consumers move up', '6.28.0,8.11.2', '8.11.2'],
  ])('refuses an Override on %s', (_label, from, to) => {
    const text = `## @slack/web-api ${from} → ${to}\nSource: x\nOverride: incident\n- y · not covered: z\n`;
    expect(gate([bump('@slack/web-api', from, to)], text).problems).toEqual([
      expect.stringContaining('is on live I/O path(s) with no real-library test: slack-files'),
    ]);
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

  it('lets one section cover packages that moved between the same versions', () => {
    const text = [
      '## @anthropic-ai/claude-agent-sdk-linux-x64, @anthropic-ai/claude-agent-sdk-darwin-arm64 0.3.290 → 0.3.300',
      'Source: https://example.com/changelog',
      '- platform binaries follow the SDK · not covered: no behaviour of their own',
    ].join('\n');
    const ledger = ledgerOf(text);
    expect([...ledger.sections.keys()]).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-x64',
      '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    ]);
    expect(ledger.sections.get('@anthropic-ai/claude-agent-sdk-darwin-arm64')?.entries).toHaveLength(1);
  });

  it('refuses a package explained in two ledgers, or a section with no entries', () => {
    const twice = parseLedgers([
      { file: 'docs/dependency-changes/a.md', text: '## zod 4.6.5 → 4.7.0\nSource: x\n' },
      { file: 'docs/dependency-changes/b.md', text: '## zod 4.6.5 → 4.7.0\nSource: x\n' },
    ]);
    expect(changeProblems(registry, reach, [bump('zod', '4.6.5', '4.7.0')], twice, exists, new Map()).problems).toEqual(
      [
        'zod has a ledger section in both docs/dependency-changes/a.md and docs/dependency-changes/b.md',
        expect.stringContaining('no entries'),
      ],
    );
  });
});

describe('Docker pins', () => {
  const tools = [
    { id: 'claude-code', arg: 'CLAUDE_CODE_VERSION', source: { kind: 'npm', package: '@anthropic-ai/claude-code' } },
  ];
  const base = 'ARG CLAUDE_CODE_VERSION=2.1.290\nRUN npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}\n';

  it.each([
    ['two spaces', 'ARG  CLAUDE_CODE_VERSION=2.1.300'],
    ['a tab', 'ARG\tCLAUDE_CODE_VERSION=2.1.300'],
    ['a lowercase keyword', 'arg CLAUDE_CODE_VERSION=2.1.300'],
  ])('reads a pin written with %s, so the bump is not mistaken for a removal', (_label, pin) => {
    expect(
      packageChanges(
        lockedVersions(files()),
        lockedVersions(files({ dockerfile: `FROM node:22-slim\n${pin}\nARG BUN_VERSION=1.4.2\n` })),
      ),
    ).toEqual([bump('docker:claude-code', '2.1.290', '2.1.300', 'docker')]);
  });

  it('refuses a tracked ARG that is used but given no value the gate can read', () => {
    const head = 'ARG CLAUDE_CODE_VERSION\nRUN npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}\n';
    expect(dockerfileProblems(base, head, tools)).toEqual([
      expect.stringContaining('uses ${CLAUDE_CODE_VERSION} but the gate reads no ARG value for it'),
    ]);
  });

  it('refuses an unpinned update of a tracked npm tool after its pinned install', () => {
    const head = base.replace(
      '${CLAUDE_CODE_VERSION}\n',
      '${CLAUDE_CODE_VERSION} && pnpm update -g @anthropic-ai/claude-code\n',
    );
    expect(dockerfileProblems(base, head, tools)).toEqual([
      expect.stringContaining('installs @anthropic-ai/claude-code as @anthropic-ai/claude-code;'),
    ]);
  });

  it('reads a pin the head dropped from update-sources, so the bump is not mistaken for a removal', () => {
    const before = files({ dockerfile: 'ARG CLAUDE_CODE_VERSION=2.1.290\n' });
    const after = files({
      dockerfile: 'ARG CLAUDE_CODE_VERSION=2.1.300\n',
      updateSources: JSON.stringify({ dockerfile: [{ id: 'bun', arg: 'BUN_VERSION' }] }),
    });
    const union = trackedTools(before.updateSources);
    expect(packageChanges(lockedVersions(before, union), lockedVersions(after, union))).toEqual([
      bump('docker:claude-code', '2.1.290', '2.1.300', 'docker'),
    ]);
  });

  it.each([
    ['a literal version', 'npm i -g @anthropic-ai/claude-code@2.1.299'],
    [
      'a dist tag, with the ARG kept alive in a comment',
      'npm i -g @anthropic-ai/claude-code@latest\n# pinned by ${CLAUDE_CODE_VERSION}',
    ],
    ['a quoted literal', 'npm install -g @anthropic-ai/claude-code@"2.1.299"'],
    ['another ARG', 'npm i -g @anthropic-ai/claude-code@${CLAUDE_NEXT}'],
    ['no version', 'npm add -g @anthropic-ai/claude-code'],
  ])('refuses a tracked npm tool installed with %s', (_label, install) => {
    const head = `ARG CLAUDE_CODE_VERSION=2.1.290\nRUN ${install}\n`;
    expect(dockerfileProblems(base, head, tools)).toEqual([
      expect.stringContaining('references ${CLAUDE_CODE_VERSION} fewer times than the base, comments aside'),
      expect.stringContaining('install it as @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}'),
    ]);
  });

  it.each([
    ['an ENV of the same name', 'ENV CLAUDE_CODE_VERSION=2.1.999', 'sets CLAUDE_CODE_VERSION with ENV'],
    ['a second valued ARG', 'ARG CLAUDE_CODE_VERSION=2.1.999', 'gives ARG CLAUDE_CODE_VERSION a value 2 times'],
    ['a lowercase env', 'env CLAUDE_CODE_VERSION=2.1.999', 'sets CLAUDE_CODE_VERSION with ENV'],
    ['a second lowercase arg', 'arg CLAUDE_CODE_VERSION=2.1.999', 'gives ARG CLAUDE_CODE_VERSION a value 2 times'],
    [
      'a second ARG spaced with a tab',
      'ARG\tCLAUDE_CODE_VERSION = 2.1.999',
      'gives ARG CLAUDE_CODE_VERSION a value 2 times',
    ],
    ['a shell assignment in a RUN', 'RUN CLAUDE_CODE_VERSION=2.1.999 && true', 'assigns CLAUDE_CODE_VERSION in a RUN'],
    ['an exported shell variable', 'RUN export CLAUDE_CODE_VERSION=2.1.999', 'assigns CLAUDE_CODE_VERSION in a RUN'],
  ])('refuses a pin shadowed by %s', (_label, shadow, message) => {
    expect(dockerfileProblems(base, base.replace('\nRUN', `\n${shadow}\nRUN`), tools)).toEqual([
      expect.stringContaining(message),
    ]);
  });

  it.each([
    ['a range', '"dbt-core>=1.12"'],
    ['extras with a literal', '"dbt-core[snowflake]==1.13"'],
    ['a name variant', 'DBT_core==1.13.0'],
  ])('refuses a tracked PyPI tool installed as %s, even with its ARG still referenced', (_label, install) => {
    const pypi = [{ id: 'dbt-core', arg: 'DBT_CORE_VERSION', source: { kind: 'pypi', package: 'dbt-core' } }];
    const pinned = 'ARG DBT_CORE_VERSION=1.12.5\nRUN pip install "dbt-core==${DBT_CORE_VERSION}"\n';
    const head = `ARG DBT_CORE_VERSION=1.12.5\nRUN pip install ${install} && echo \${DBT_CORE_VERSION}\n`;
    expect(dockerfileProblems(pinned, head, pypi)).toEqual([
      expect.stringContaining('install it as dbt-core==${DBT_CORE_VERSION}'),
    ]);
  });

  it('refuses a tracked PyPI tool at a literal version, and accepts both kinds from their ARG', () => {
    const pypi = [{ id: 'dbt-core', arg: 'DBT_CORE_VERSION', source: { kind: 'pypi', package: 'dbt-core' } }];
    const pinned =
      'ARG DBT_CORE_VERSION=1.12.5\nRUN /opt/v/bin/pip install "dbt-core==${DBT_CORE_VERSION}" \\\n  && dbt-core --version\n';
    expect(dockerfileProblems(pinned, pinned.replace('==${DBT_CORE_VERSION}', '==1.13.0'), pypi)).toEqual([
      expect.stringContaining('fewer times'),
      expect.stringContaining('install it as dbt-core==${DBT_CORE_VERSION}'),
    ]);
    expect(dockerfileProblems(pinned, pinned.replace('1.12.5', '1.13.0'), pypi)).toEqual([]);
    expect(dockerfileProblems(base, base.replace('2.1.290', '2.1.300'), tools)).toEqual([]);
  });
});

/** A pnpm lockfile from `node → { dep: version }`; every node is also a package. */
const lockOf = (snapshots: Record<string, Record<string, string>>): string => {
  const nodes = Object.keys(snapshots);
  const packages = nodes.map((node) => `  '${node}':\n    resolution: {integrity: sha512-x}\n`).join('\n');
  const snaps = nodes
    .map((node) => {
      const deps = Object.entries(snapshots[node]!);
      return deps.length === 0
        ? `  '${node}': {}\n`
        : `  '${node}':\n    dependencies:\n${deps.map(([d, v]) => `      '${d}': ${v}\n`).join('')}`;
    })
    .join('\n');
  return `lockfileVersion: '9.0'\n\npackages:\n\n${packages}\nsnapshots:\n\n${snaps}`;
};

/** The gate's own pipeline over two host lockfiles. */
const judge = (
  before: string,
  after: string,
  text = '',
  baseReg: Registry = registry,
  headReg: Registry = registry,
) => {
  const base = lockedVersions(files({ pnpmLock: before }));
  const head = lockedVersions(files({ pnpmLock: after }));
  const changes = packageChanges(base, head);
  const repoints = consumerMoves(base, head);
  const moves = liveMoves(liveAtEitherEnd(baseReg, headReg), base, head, repatchedPackages(base, head), repoints);
  return changeProblems(
    headReg,
    runtimeReach(headReg, head.dependsOn),
    withRepoints(changes, repoints, moves, head),
    ledgerOf(text),
    exists,
    moves,
    baseReg,
  ).problems;
};

describe('moves the locked version set does not show', () => {
  const stack = (wsUnderDiscord: string) =>
    lockOf({
      'chat@4.41.1': {},
      '@chat-adapter/discord@4.41.1': { 'discord.js': '14.27.0' },
      'discord.js@14.27.0': { ws: wsUnderDiscord },
      'other@1.0.0': { ws: '8.22.0' },
      'ws@8.21.0': {},
      'ws@8.22.0': {},
    });

  it('blocks a live package repointed onto a version already locked for something else', () => {
    expect(judge(stack('8.21.0'), stack('8.22.0'))).toEqual([
      expect.stringContaining(
        'ws 8.21.0 → 8.22.0 (loaded by @chat-adapter/discord) is on live I/O path(s) with no real-library test',
      ),
    ]);
  });

  it('still blocks the move when the same change reclassifies the live package above it', () => {
    const weakened: Registry = {
      ...registry,
      packages: { ...registry.packages, '@chat-adapter/discord': { kind: 'runtime' } },
    };
    const text = 'Reclassified: @chat-adapter/discord · not really live\n';
    expect(judge(stack('8.21.0'), stack('8.22.0'), text, registry, weakened)).toEqual([
      expect.stringContaining('ws 8.21.0 → 8.22.0 (loaded by @chat-adapter/discord) is on live I/O path(s)'),
    ]);
  });

  it('wants a ledger when a runtime consumer is repointed across a major onto a version already locked', () => {
    const tree = (luxon: string) =>
      lockOf({ 'zod@4.6.5': { luxon }, 'other@1.0.0': { luxon: '4.0.0' }, 'luxon@3.7.2': {}, 'luxon@4.0.0': {} });
    expect(judge(tree('3.7.2'), tree('4.0.0'))).toEqual([expect.stringContaining('"## luxon 3.7.2 → 4.0.0" section')]);
  });

  it('refuses an Override for an upgrade split across two lockfiles', () => {
    const remotion = (v: string) => lockOf({ [`zod@${v}`]: {} });
    const runner = (v: string) =>
      `{\n  "lockfileVersion": 1,\n  "packages": {\n    "zod": ["zod@${v}", "", {}, "sha512-x"],\n  },\n}\n`;
    const base = lockedVersions(files({ remotionLock: remotion('4.6.5'), bunLock: runner('3.25.0') }));
    const head = lockedVersions(files({ remotionLock: remotion('3.25.0'), bunLock: runner('4.6.5') }));
    const [change] = packageChanges(base, head);
    expect(change).toMatchObject({ name: 'zod', added: ['3.25.0', '4.6.5'], removed: ['3.25.0', '4.6.5'] });
    const live: Registry = {
      ...registry,
      packages: { ...registry.packages, zod: { kind: 'live', paths: ['provider-claude'] } },
    };
    const text = '## zod 3.25.0,4.6.5 → 3.25.0,4.6.5\nSource: x\nOverride: incident\n- y · not covered: z\n';
    expect(gate([change!], text, live).problems).toEqual([
      expect.stringContaining('no real-library test: provider-claude'),
    ]);
  });

  /** `lockOf` with a root project that depends on `deps`. */
  const project = (lock: string, deps: Record<string, string>): string =>
    lock.replace(
      "lockfileVersion: '9.0'\n",
      `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n${Object.entries(deps)
        .map(([d, v]) => `      '${d}':\n        specifier: ${v}\n        version: ${v}\n`)
        .join('')}`,
    );

  it('blocks the project moving a live package onto a version already locked for something else', () => {
    const tree = (adapter: string) =>
      project(
        lockOf({
          '@chat-adapter/discord@4.41.1': { 'discord.js': '14.27.0' },
          '@chat-adapter/discord@4.42.0': { 'discord.js': '14.99.0' },
          'zzother@1.0.0': { '@chat-adapter/discord': '4.42.0' },
          'discord.js@14.27.0': {},
          'discord.js@14.99.0': {},
        }),
        { '@chat-adapter/discord': adapter, zzother: '1.0.0' },
      );
    expect(judge(tree('4.41.1'), tree('4.42.0'))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '@chat-adapter/discord 4.41.1 → 4.42.0 is on live I/O path(s) with no real-library test',
        ),
      ]),
    );
  });

  it('blocks a consumer under a live package moved onto a version that package already loads elsewhere', () => {
    const tree = (undici: string) =>
      lockOf({
        '@chat-adapter/discord@4.41.1': { 'discord.js': '14.27.0', rest: '2.6.3' },
        'discord.js@14.27.0': { undici },
        'rest@2.6.3': { undici: '8.11.2' },
        'undici@6.28.0': {},
        'undici@8.11.2': {},
      });
    expect(judge(tree('6.28.0'), tree('8.11.2'))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('undici 6.28.0 → 8.11.2 (loaded by @chat-adapter/discord) is on live I/O path(s)'),
      ]),
    );
  });

  it('refuses an Override for a consumer upgrade hidden behind a version set that looks like a rollback', () => {
    const before = lockOf({
      '@chat-adapter/discord@4.41.1': { rest: '2.6.3' },
      'rest@2.6.3': { undici: '6.28.0' },
      'other@1.0.0': { undici: '8.11.2' },
      'undici@6.28.0': {},
      'undici@8.11.2': {},
    });
    const after = lockOf({
      '@chat-adapter/discord@4.41.1': { rest: '2.6.3' },
      'rest@2.6.3': { undici: '8.11.2' },
      'other@1.0.0': { undici: '8.11.2' },
      'undici@6.0.0': {},
      'undici@8.11.2': {},
    });
    const text = '## undici 6.28.0,8.11.2 → 6.0.0,8.11.2\nSource: x\nOverride: incident\n- y · not covered: z\n';
    expect(judge(before, after, text)).toEqual([
      expect.stringContaining('undici 6.28.0,8.11.2 → 6.0.0,8.11.2 (loaded by @chat-adapter/discord) is on live I/O'),
    ]);
  });

  it('does not block a type-only package moving beneath a live package', () => {
    const tree = (types: string) =>
      lockOf({ '@chat-adapter/discord@4.41.1': { '@types/ws': types }, [`@types/ws@${types}`]: {} });
    expect(judge(tree('8.18.1'), tree('8.18.2'))).toEqual([]);
  });

  it('counts only a changed patch as a re-patch, not a version one tree dropped while another kept it', () => {
    const runner = `{
  "lockfileVersion": 1,
  "packages": {
    "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.290", "", { "dependencies": { "inherits": "^2" } }, "sha512-x"],
    "inherits": ["inherits@2.0.4", "", {}, "sha512-x"],
  },
}
`;
    const base = lockedVersions(files({ pnpmLock: lockOf({ 'inherits@2.0.4': {} }), bunLock: runner }));
    const head = lockedVersions(files({ pnpmLock: lockOf({ 'chat@4.41.1': {} }), bunLock: runner }));
    expect(packageChanges(base, head)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'inherits', from: '2.0.4', to: '2.0.4' })]),
    );
    const live: Registry = {
      ...registry,
      packages: {
        ...registry.packages,
        '@anthropic-ai/claude-agent-sdk': { kind: 'live', paths: ['provider-claude'] },
      },
    };
    expect(repatchedPackages(base, head)).toEqual(new Map());
    expect(liveMoves(live, base, head, repatchedPackages(base, head)).get('runner')).toBeUndefined();
  });

  it('follows a bun peer dependency into the live closure', () => {
    const bun = (zod: string) => `{
  "lockfileVersion": 1,
  "packages": {
    "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.290", "", { "peerDependencies": { "zod": "^4" } }, "sha512-x"],
    "zod": ["zod@${zod}", "", {}, "sha512-x"],
  },
}
`;
    const live: Registry = {
      ...registry,
      packages: {
        ...registry.packages,
        '@anthropic-ai/claude-agent-sdk': { kind: 'live', paths: ['provider-claude'] },
      },
    };
    const moves = liveMoves(
      live,
      lockedVersions(files({ bunLock: bun('4.6.5') })),
      lockedVersions(files({ bunLock: bun('4.7.0') })),
      new Map(),
    );
    expect(moves.get('runner')?.get('zod')).toEqual(new Set(['@anthropic-ai/claude-agent-sdk']));
  });
});
