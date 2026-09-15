/**
 * `excludePlugins` honoured in the container, by each walker, in its own
 * namespace.
 *
 * Every assertion here is an EFFECT on the thing the provider actually
 * consumes — the SDK `plugins:` list (which is what carries a plugin's hooks),
 * the Codex registration plan, the mirrored skill set — not an exit code and
 * not "the function was called". #826's mask was removed because the host
 * cannot predict what these walks resolve; these tests drive the walks.
 *
 * The fixture is one plugins root shaped like the real one, and carries BOTH
 * sub-plugin layouts every walker knows: a `bootstrap` monorepo holding
 * `plugins/orchestrate` + `plugins/orchestrate-agents` (the pair an operator
 * wants withheld) beside `plugins/workflow-agents` and `plugins/wwbd` (which
 * must survive); a `knowledge` monorepo whose sub-plugins sit at its ROOT
 * (`knowledge/data`, `knowledge/docs`); and a `standalone` repo that is itself
 * one plugin.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { planCodexPluginRegistration } from './codex-companion-setup.js';
import { isExcludedPluginPath, splitExcludedPlugins } from './plugin-exclusions.js';
import { discoverPortableSkills } from './plugin-skill-discovery.js';
import { discoverPlugins } from './providers/claude.js';

const ORCHESTRATE_PAIR = ['bootstrap/plugins/orchestrate', 'bootstrap/plugins/orchestrate-agents'];

/**
 * Every sub-plugin the fixture carries, as the walkers see it: both the
 * `<repo>/plugins/<sub>` layout and the `<repo>/<sub>` one. Basenames are
 * unique across the fixture, so a walker's output can be mapped back to the
 * sub-path it came from.
 */
const SUB_PLUGINS = [
  'bootstrap/plugins/orchestrate',
  'bootstrap/plugins/orchestrate-agents',
  'bootstrap/plugins/workflow-agents',
  'bootstrap/plugins/wwbd',
  'knowledge/data',
  'knowledge/docs',
];

const basename = (subPath: string): string => subPath.split('/').at(-1) as string;

let root: string;

function writeJson(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`);
}

/** One sub-plugin: a Claude manifest, a Codex manifest, and one skill. */
function writeSubPlugin(dir: string, name: string): void {
  writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name });
  writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name });
  writeSkill(path.join(dir, 'skills', name), name);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-exclusions-'));
  for (const repo of ['bootstrap', 'knowledge']) {
    writeJson(path.join(root, repo, '.claude-plugin', 'marketplace.json'), { name: repo });
  }
  for (const subPath of SUB_PLUGINS) {
    writeSubPlugin(path.join(root, ...subPath.split('/')), basename(subPath));
  }
  const standalone = path.join(root, 'standalone');
  writeJson(path.join(standalone, '.claude-plugin', 'plugin.json'), { name: 'standalone' });
  writeJson(path.join(standalone, '.claude-plugin', 'marketplace.json'), { name: 'standalone' });
  writeJson(path.join(standalone, '.codex-plugin', 'plugin.json'), { name: 'standalone' });
  writeSkill(path.join(standalone, 'skills', 'standalone'), 'standalone');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Claude discoverPlugins', () => {
  it('drops an excluded sub-plugin from the SDK plugin list, keeping its siblings', () => {
    const before = discoverPlugins(root, splitExcludedPlugins(undefined)).plugins.map((p) => p.path);
    expect(before).toContain(path.join(root, 'bootstrap', 'plugins', 'orchestrate'));
    expect(before).toContain(path.join(root, 'bootstrap', 'plugins', 'orchestrate-agents'));

    const after = discoverPlugins(root, splitExcludedPlugins(ORCHESTRATE_PAIR)).plugins.map((p) => p.path);
    expect(after).not.toContain(path.join(root, 'bootstrap', 'plugins', 'orchestrate'));
    expect(after).not.toContain(path.join(root, 'bootstrap', 'plugins', 'orchestrate-agents'));
    expect(after).toContain(path.join(root, 'bootstrap', 'plugins', 'workflow-agents'));
    expect(after).toContain(path.join(root, 'bootstrap', 'plugins', 'wwbd'));
    expect(after).toContain(path.join(root, 'standalone'));
  });

  it("drops the excluded plugin's PreToolUse guard with it — the hooks ride on the plugin entry", () => {
    // A plugin reaches the SDK as one `{type:'local', path}` entry: its
    // SessionStart hook and its declared guards arrive together or not at all.
    writeJson(path.join(root, 'bootstrap', 'plugins', 'orchestrate', 'nanoclaw-plugin.json'), {
      preToolUseGuards: ['orchestrate-guard'],
    });
    writeJson(path.join(root, 'bootstrap', 'plugins', 'wwbd', 'nanoclaw-plugin.json'), {
      preToolUseGuards: ['wwbd-guard'],
    });
    expect(discoverPlugins(root, splitExcludedPlugins(undefined)).preToolUseGuards).toContain('orchestrate-guard');

    const after = discoverPlugins(root, splitExcludedPlugins(ORCHESTRATE_PAIR));
    expect(after.preToolUseGuards).not.toContain('orchestrate-guard');
    expect(after.preToolUseGuards).toContain('wwbd-guard');
  });

  it('excludes a single-plugin repo named at the top level — its manifest is at the ROOT, so no deeper check sees it', () => {
    // The only shape the top-level check alone catches: a repo the walk
    // registers without descending. (In production the host already omits a
    // top-level entry from the mount; this walker does not depend on that.)
    const after = discoverPlugins(root, splitExcludedPlugins(['standalone'])).plugins.map((p) =>
      path.relative(root, p.path),
    );
    expect(after).not.toContain('standalone');
    expect(after).toContain(path.join('bootstrap', 'plugins', 'orchestrate'));
  });

  it('excludes the whole subtree when a repo is excluded at the top level', () => {
    const after = discoverPlugins(root, splitExcludedPlugins(['bootstrap']))
      .plugins.map((p) => path.relative(root, p.path))
      .sort();
    expect(after).toEqual(['knowledge/data', 'knowledge/docs', 'standalone']);
  });
});

describe('Codex planCodexPluginRegistration', () => {
  const registered = (entries: string[] | undefined): string[] =>
    planCodexPluginRegistration(root, splitExcludedPlugins(entries))
      .filter((p) => p.action === 'register')
      .map((p) => p.name)
      .sort();

  it('does not register an excluded sub-plugin — so nothing `codex plugin add`s it, or trusts its hooks', () => {
    expect(registered(undefined)).toEqual([
      'bootstrap/orchestrate',
      'bootstrap/orchestrate-agents',
      'bootstrap/workflow-agents',
      'bootstrap/wwbd',
      'knowledge/data',
      'knowledge/docs',
      'standalone',
    ]);
    expect(registered(ORCHESTRATE_PAIR)).toEqual([
      'bootstrap/workflow-agents',
      'bootstrap/wwbd',
      'knowledge/data',
      'knowledge/docs',
      'standalone',
    ]);
    // The root layout is honoured the same way.
    expect(registered(['knowledge/data'])).toEqual([
      'bootstrap/orchestrate',
      'bootstrap/orchestrate-agents',
      'bootstrap/workflow-agents',
      'bootstrap/wwbd',
      'knowledge/docs',
      'standalone',
    ]);
  });

  it('skips an excluded top-level repo with a reason naming the config', () => {
    const plan = planCodexPluginRegistration(root, splitExcludedPlugins(['standalone']));
    expect(plan.find((p) => p.name === 'standalone')).toEqual({
      name: 'standalone',
      action: 'skip',
      reason: 'excluded-by-config',
    });
  });
});

describe('skill mirror discoverPortableSkills', () => {
  const skillNames = (entries: string[] | undefined): string[] =>
    discoverPortableSkills(root, {
      runtime: 'opencode',
      excludePlugins: splitExcludedPlugins(entries),
    })
      .map((s) => s.name)
      .sort();

  it("drops an excluded sub-plugin's skills and keeps every sibling's", () => {
    expect(skillNames(undefined)).toEqual([
      'data',
      'docs',
      'orchestrate',
      'orchestrate-agents',
      'standalone',
      'workflow-agents',
      'wwbd',
    ]);
    expect(skillNames(ORCHESTRATE_PAIR)).toEqual(['data', 'docs', 'standalone', 'workflow-agents', 'wwbd']);
    // The root layout again — rule 8 of the discovery order, not rule 7.
    expect(skillNames(['knowledge/data'])).toEqual([
      'docs',
      'orchestrate',
      'orchestrate-agents',
      'standalone',
      'workflow-agents',
      'wwbd',
    ]);
  });

  it('drops a whole repo for a top-level entry', () => {
    expect(skillNames(['bootstrap'])).toEqual(['data', 'docs', 'standalone']);
    // A single-plugin repo: its skills come from the repo root (rules 1-6), not
    // from a sub-plugin rule, so only the top-level check can withhold them.
    expect(skillNames(['standalone'])).toEqual([
      'data',
      'docs',
      'orchestrate',
      'orchestrate-agents',
      'workflow-agents',
      'wwbd',
    ]);
  });
});

describe('the three walkers and the predicate agree', () => {
  // Point of this block: one fixture, one list, and the set each walker
  // withholds is EXACTLY the set `isExcludedPluginPath` marks — the same
  // predicate the host's always-on composer asks (`src/claude-md-compose.ts`,
  // through the byte-identical `src/plugin-exclusions.ts`). Compared by
  // basename because that is the only identifier all three outputs share.
  it('withholds exactly the sub-plugins the predicate excludes, for every list shape', () => {
    for (const entries of [
      undefined,
      [],
      ORCHESTRATE_PAIR,
      ['bootstrap/plugins/wwbd'],
      ['bootstrap/plugins'],
      ['bootstrap/plugins', 'bootstrap/plugins/orchestrate'],
      ['knowledge/data'],
      ['knowledge'],
    ]) {
      const excluded = splitExcludedPlugins(entries);
      const expected = SUB_PLUGINS.filter((subPath) => !isExcludedPluginPath(subPath, excluded))
        .map(basename)
        .sort();

      const claude = discoverPlugins(root, excluded)
        .plugins.map((p) => basename(path.relative(root, p.path)))
        .filter((name) => name !== 'standalone')
        .sort();
      expect(claude).toEqual(expected);

      const codex = planCodexPluginRegistration(root, excluded)
        .filter((p) => p.action === 'register' && p.name.includes('/'))
        .map((p) => p.entryName as string)
        .sort();
      expect(codex).toEqual(expected);

      const skills = discoverPortableSkills(root, { runtime: 'opencode', excludePlugins: excluded })
        .filter((s) => s.name !== 'standalone')
        .map((s) => s.name)
        .sort();
      expect(skills).toEqual(expected);
    }
  });
});

describe('an exclusion that matches nothing', () => {
  it('is a no-op, not a failure — the walkers deliver exactly what they would have', () => {
    // An operator can name a sub-plugin that was never checked out, or misspell
    // one. Refusing the spawn over that would take a group down for a line with
    // no effect; the walk simply never meets the path.
    const ghost = splitExcludedPlugins(['bootstrap/plugins/does-not-exist', 'knowledge/never-cloned', 'no-such-repo']);
    const none = splitExcludedPlugins(undefined);
    expect(discoverPlugins(root, ghost).plugins).toEqual(discoverPlugins(root, none).plugins);
    expect(planCodexPluginRegistration(root, ghost)).toEqual(planCodexPluginRegistration(root, none));
    expect(discoverPortableSkills(root, { runtime: 'opencode', excludePlugins: ghost })).toEqual(
      discoverPortableSkills(root, { runtime: 'opencode', excludePlugins: none }),
    );
  });
});
