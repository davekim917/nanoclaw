import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { splitExcludedPlugins } from '../plugin-exclusions.js';
import { copyOpenCodeSkills, excludedOpenCodeSkillNames } from './opencode.js';

/**
 * OpenCode receives skills by two paths, and only one of them is inside the
 * container. This covers the other: the host's per-sibling mirror, built with
 * no agent group in hand, copied into the session XDG at spawn. Without the
 * filter an excluded sub-plugin's skill still reaches an OpenCode group, and
 * the operator's exclusion is half-applied on exactly one provider.
 */
describe('excludedOpenCodeSkillNames', () => {
  let plugins: string;

  const writeSkill = (dir: string, name: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`);
  };

  beforeEach(() => {
    plugins = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-exclusion-'));
    fs.mkdirSync(path.join(plugins, 'mono', '.claude-plugin'), { recursive: true });
    for (const sub of ['alpha', 'delta']) {
      fs.mkdirSync(path.join(plugins, 'mono', 'plugins', sub, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(plugins, 'mono', 'plugins', sub, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: sub }),
      );
      writeSkill(path.join(plugins, 'mono', 'plugins', sub, 'skills', sub), sub);
    }
    // A single-plugin repo, so a top-level entry has skills of its own to lose.
    writeSkill(path.join(plugins, 'solo', 'skills', 'solo-skill'), 'solo-skill');
  });

  afterEach(() => {
    fs.rmSync(plugins, { recursive: true, force: true });
  });

  it('names exactly the skills an excluded sub-plugin contributed', () => {
    const dropped = excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['mono/plugins/alpha']));
    expect([...dropped]).toEqual(['alpha']);
  });

  it('returns an empty set for a group that excludes nothing — the copy is untouched for every group today', () => {
    expect(excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(undefined)).size).toBe(0);
    expect(excludedOpenCodeSkillNames(plugins, splitExcludedPlugins([])).size).toBe(0);
  });

  it('leaves a TOP-LEVEL entry alone — that mirror behaviour is pre-existing and live groups run on it', () => {
    // Every OpenCode group on this install carries top-level entries today and
    // keeps those skills through this mirror. Widening the filter to them would
    // withdraw skills from running groups; that is not this change.
    expect(excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['mono'])).size).toBe(0);
    // `solo` HAS a skill in this mirror, and excluding it top-level alongside a
    // sub-path must still drop only the sub-path's.
    const mixed = excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['solo', 'mono/plugins/alpha']));
    expect([...mixed]).toEqual(['alpha']);
  });

  it('keeps a skill name another, non-excluded plugin also provides', () => {
    // First-plugin-wins dedup means the name still has a live source, so
    // dropping it would withhold a skill the exclusion never named.
    fs.mkdirSync(path.join(plugins, 'aardvark'), { recursive: true });
    writeSkill(path.join(plugins, 'aardvark', 'skills', 'alpha'), 'alpha');
    const dropped = excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['mono/plugins/alpha']));
    expect(dropped.has('alpha')).toBe(false);
  });

  it('covers the `plugin/` root layout, which discovery walks by fixed name', () => {
    // discoverPortableSkills reaches a skill at `<repo>/plugin/skills/<name>`
    // by a fixed-name rule, not by the manifest-gated sub-plugin rules. This
    // drop set never asks discovery to filter — it asks the predicate about
    // each discovered skill's own path — so the layout is covered by ancestor
    // coverage over `path.relative(pluginsRoot, skillDir)` rather than by
    // anything layout-specific. That is what this pins: the same entry that
    // withholds the sub-plugin from the container walkers also withholds its
    // skill from the session XDG copy.
    writeSkill(path.join(plugins, 'layouts', 'plugin', 'skills', 'via-plugin-dir'), 'via-plugin-dir');
    expect([...excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['layouts/plugin']))]).toEqual([
      'via-plugin-dir',
    ]);
    // And an unrelated exclusion leaves it alone.
    expect(
      excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['mono/plugins/alpha'])).has('via-plugin-dir'),
    ).toBe(false);
  });

  it('drops a duplicated name when the EXCLUDED source is the one the mirror published', () => {
    // The inverse of the case above, and the one a name-only difference got
    // wrong: `mono` sorts before `zulu`, so the excluded sub-plugin wins
    // discovery's first-plugin-wins dedup and its directory is what the shared
    // mirror holds under this name. The name still exists in a filtered walk —
    // supplied by `zulu` — so comparing names alone would read it as kept and
    // copy the excluded source into the group's XDG, inverting the exclusion.
    // `zulu`'s copy is not lost: the container-side mirror honours the same
    // list over `/workspace/plugins` and picks it up there.
    fs.mkdirSync(path.join(plugins, 'zulu'), { recursive: true });
    writeSkill(path.join(plugins, 'zulu', 'skills', 'alpha'), 'alpha');
    const dropped = excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['mono/plugins/alpha']));
    expect(dropped.has('alpha')).toBe(true);
    // And only that name — `delta` shares the repo but not the excluded path.
    expect([...dropped]).toEqual(['alpha']);
  });
});

describe('copyOpenCodeSkills with a drop set', () => {
  let source: string;
  let target: string;
  let allowedRoots: string[];

  beforeEach(() => {
    source = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mirror-'));
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-xdg-'));
    // No symlinks in this fixture, so containment decides nothing here; the
    // drop-set behaviour is what these cases pin.
    allowedRoots = [fs.realpathSync(source)];
    for (const name of ['alpha', 'team-auto', 'delta']) {
      fs.mkdirSync(path.join(source, name, 'references'), { recursive: true });
      fs.writeFileSync(path.join(source, name, 'SKILL.md'), name);
      fs.writeFileSync(path.join(source, name, 'references', 'notes.md'), name);
      // The marker syncSkillSymlinks writes into every dir IT published. Its
      // absence is the mirror's only record that a dir was placed by someone
      // else, and the copy refuses to drop those.
      fs.writeFileSync(path.join(source, name, '.nanoclaw-managed'), 'managed by nanoclaw plugin-skill-discovery\n');
    }
  });

  afterEach(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('omits a dropped skill entirely — children included — and copies every other', () => {
    copyOpenCodeSkills(source, target, { dropNames: new Set(['alpha']), allowedRoots });
    expect(fs.readdirSync(target).sort()).toEqual(['delta', 'team-auto']);
    expect(fs.existsSync(path.join(target, 'alpha', 'references', 'notes.md'))).toBe(false);
    expect(fs.readFileSync(path.join(target, 'delta', 'references', 'notes.md'), 'utf8')).toBe('delta');
  });

  it('never mutates the host-owned mirror it copied from', () => {
    copyOpenCodeSkills(source, target, { dropNames: new Set(['alpha']), allowedRoots });
    expect(fs.readdirSync(source).sort()).toEqual(['alpha', 'delta', 'team-auto']);
  });

  it('copies everything when the drop set is empty (the default)', () => {
    copyOpenCodeSkills(source, target, { allowedRoots });
    expect(fs.readdirSync(target).sort()).toEqual(['alpha', 'delta', 'team-auto']);
  });

  it('NEVER drops a dir the mirror writer did not publish, even when the name is in the drop set', () => {
    // `syncSkillSymlinks` preserves a directory it did not create rather than
    // overwriting it (`isManagedMirror`, src/plugin-skill-discovery.ts), so an
    // operator-placed or natively-installed `<mirror>/<name>` survives every
    // sync. The drop set names a SOURCE in ~/plugins; if an excluded plugin
    // happens to publish the same name, dropping on the name alone would
    // withdraw this content from the session — a guard refusing a legitimate
    // state instead of the bad input.
    fs.rmSync(path.join(source, 'alpha', '.nanoclaw-managed'));
    copyOpenCodeSkills(source, target, { dropNames: new Set(['alpha']), allowedRoots });
    expect(fs.readdirSync(target).sort()).toEqual(['alpha', 'delta', 'team-auto']);
    expect(fs.readFileSync(path.join(target, 'alpha', 'references', 'notes.md'), 'utf8')).toBe('alpha');
  });
});
