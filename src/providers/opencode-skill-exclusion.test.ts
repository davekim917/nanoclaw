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
    fs.mkdirSync(path.join(plugins, 'bootstrap', '.claude-plugin'), { recursive: true });
    for (const sub of ['orchestrate', 'wwbd']) {
      fs.mkdirSync(path.join(plugins, 'bootstrap', 'plugins', sub, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(plugins, 'bootstrap', 'plugins', sub, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: sub }),
      );
      writeSkill(path.join(plugins, 'bootstrap', 'plugins', sub, 'skills', sub), sub);
    }
    // A single-plugin repo, so a top-level entry has skills of its own to lose.
    writeSkill(path.join(plugins, 'solo', 'skills', 'solo-skill'), 'solo-skill');
  });

  afterEach(() => {
    fs.rmSync(plugins, { recursive: true, force: true });
  });

  it('names exactly the skills an excluded sub-plugin contributed', () => {
    const dropped = excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['bootstrap/plugins/orchestrate']));
    expect([...dropped]).toEqual(['orchestrate']);
  });

  it('returns an empty set for a group that excludes nothing — the copy is untouched for every group today', () => {
    expect(excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(undefined)).size).toBe(0);
    expect(excludedOpenCodeSkillNames(plugins, splitExcludedPlugins([])).size).toBe(0);
  });

  it('leaves a TOP-LEVEL entry alone — that mirror behaviour is pre-existing and live groups run on it', () => {
    // Every OpenCode group on this install carries top-level entries today and
    // keeps those skills through this mirror. Widening the filter to them would
    // withdraw skills from running groups; that is not this change.
    expect(excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['bootstrap'])).size).toBe(0);
    // `solo` HAS a skill in this mirror, and excluding it top-level alongside a
    // sub-path must still drop only the sub-path's.
    const mixed = excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['solo', 'bootstrap/plugins/orchestrate']));
    expect([...mixed]).toEqual(['orchestrate']);
  });

  it('keeps a skill name another, non-excluded plugin also provides', () => {
    // First-plugin-wins dedup means the name still has a live source, so
    // dropping it would withhold a skill the exclusion never named.
    fs.mkdirSync(path.join(plugins, 'aardvark'), { recursive: true });
    writeSkill(path.join(plugins, 'aardvark', 'skills', 'orchestrate'), 'orchestrate');
    const dropped = excludedOpenCodeSkillNames(plugins, splitExcludedPlugins(['bootstrap/plugins/orchestrate']));
    expect(dropped.has('orchestrate')).toBe(false);
  });
});

describe('copyOpenCodeSkills with a drop set', () => {
  let source: string;
  let target: string;

  beforeEach(() => {
    source = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mirror-'));
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-xdg-'));
    for (const name of ['orchestrate', 'team-auto', 'wwbd']) {
      fs.mkdirSync(path.join(source, name, 'references'), { recursive: true });
      fs.writeFileSync(path.join(source, name, 'SKILL.md'), name);
      fs.writeFileSync(path.join(source, name, 'references', 'notes.md'), name);
    }
  });

  afterEach(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('omits a dropped skill entirely — children included — and copies every other', () => {
    copyOpenCodeSkills(source, target, new Set(['orchestrate']));
    expect(fs.readdirSync(target).sort()).toEqual(['team-auto', 'wwbd']);
    expect(fs.existsSync(path.join(target, 'orchestrate', 'references', 'notes.md'))).toBe(false);
    expect(fs.readFileSync(path.join(target, 'wwbd', 'references', 'notes.md'), 'utf8')).toBe('wwbd');
  });

  it('never mutates the host-owned mirror it copied from', () => {
    copyOpenCodeSkills(source, target, new Set(['orchestrate']));
    expect(fs.readdirSync(source).sort()).toEqual(['orchestrate', 'team-auto', 'wwbd']);
  });

  it('copies everything when the drop set is empty (the default)', () => {
    copyOpenCodeSkills(source, target);
    expect(fs.readdirSync(target).sort()).toEqual(['orchestrate', 'team-auto', 'wwbd']);
  });
});
