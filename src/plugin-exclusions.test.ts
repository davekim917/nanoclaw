import { describe, expect, it } from 'vitest';

import { isExcludedPluginPath, splitExcludedPlugins } from './plugin-exclusions.js';

/**
 * `isExcludedPluginPath` is the one question every consumer asks — the host's
 * always-on composer and all three in-container walkers. The table below is the
 * contract they share; `plugin-exclusions-parity.test.ts` proves the container
 * is running this exact implementation.
 */
describe('isExcludedPluginPath', () => {
  const excluded = splitExcludedPlugins([
    'legacy-repo',
    'bootstrap/plugins/orchestrate',
    'bootstrap/plugins/orchestrate-agents',
    'monorepo/data',
  ]);

  const cases: Array<[string, boolean]> = [
    // Top-level entry: the repo and everything under it.
    ['legacy-repo', true],
    ['legacy-repo/plugins/anything', true],
    ['legacy-repo/anything/deeper', true],
    // Exact sub-path matches.
    ['bootstrap/plugins/orchestrate', true],
    ['bootstrap/plugins/orchestrate-agents', true],
    ['monorepo/data', true],
    // Ancestor coverage: a level below an excluded sub-path.
    ['monorepo/data/nested', true],
    // Siblings of an excluded sub-path survive.
    ['bootstrap/plugins/workflow-agents', false],
    ['bootstrap/plugins/wwbd', false],
    ['bootstrap', false],
    ['monorepo', false],
    ['monorepo/docs', false],
    // A prefix that is not a path-segment boundary is NOT a match.
    ['legacy-repo-2', false],
    ['bootstrap/plugins/orchestrate-extras', false],
    // The plugins layout and the root layout are different paths.
    ['bootstrap/orchestrate', false],
  ];

  for (const [relPath, expected] of cases) {
    it(`${expected ? 'excludes' : 'keeps'} ${relPath}`, () => {
      expect(isExcludedPluginPath(relPath, excluded)).toBe(expected);
    });
  }

  it('excludes nothing when the list is empty or absent', () => {
    for (const entries of [undefined, []]) {
      const none = splitExcludedPlugins(entries);
      expect(isExcludedPluginPath('bootstrap', none)).toBe(false);
      expect(isExcludedPluginPath('bootstrap/plugins/orchestrate', none)).toBe(false);
    }
  });

  it('answers for a sub-path whose ancestor is also listed — the redundant pair #826 refused to mount', () => {
    // `splitExcludedPlugins` drops the descendant from `subPaths`; the ancestor
    // still answers true for it, which is the property that let the redundant
    // pair stop being a spawn failure.
    const pair = splitExcludedPlugins(['bootstrap/plugins', 'bootstrap/plugins/orchestrate']);
    expect([...pair.subPaths]).toEqual(['bootstrap/plugins']);
    expect(isExcludedPluginPath('bootstrap/plugins/orchestrate', pair)).toBe(true);
    expect(isExcludedPluginPath('bootstrap/plugins/orchestrate/inner', pair)).toBe(true);
    expect(isExcludedPluginPath('bootstrap/other', pair)).toBe(false);
  });
});
