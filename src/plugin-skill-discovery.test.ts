/**
 * Tests for plugin-skill discovery.
 *
 * Builds a fake `~/plugins/`-style tree and verifies the preference order +
 * denylist + frontmatter filtering produce the expected skill set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { discoverPortableSkills, syncSkillSymlinks } from './plugin-skill-discovery.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-disc-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSkill(dir: string, frontmatter: Record<string, string> = {}, body = 'body'): void {
  fs.mkdirSync(dir, { recursive: true });
  const fmLines = ['---', ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), '---', '', body];
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fmLines.join('\n') + '\n');
}

describe('discoverPortableSkills', () => {
  it('returns empty when root does not exist', () => {
    expect(discoverPortableSkills(path.join(tmpDir, 'missing'))).toEqual([]);
  });

  it('finds top-level skills/<name>/SKILL.md', () => {
    writeSkill(path.join(tmpDir, 'plug-a', 'skills', 'foo'), { name: 'foo' });
    writeSkill(path.join(tmpDir, 'plug-a', 'skills', 'bar'), { name: 'bar' });
    const out = discoverPortableSkills(tmpDir);
    expect(out.map((s) => s.name).sort()).toEqual(['bar', 'foo']);
    expect(out.every((s) => s.plugin === 'plug-a')).toBe(true);
  });

  it('prefers .agents/skills/ over runtime-specific copies', () => {
    writeSkill(path.join(tmpDir, 'plug-a', '.agents', 'skills', 'sk1'), { name: 'sk1', body: 'AGENTS-VERSION' });
    writeSkill(path.join(tmpDir, 'plug-a', '.claude', 'skills', 'sk1'), { name: 'sk1', body: 'CLAUDE-VERSION' });
    writeSkill(path.join(tmpDir, 'plug-a', '.cursor', 'skills', 'sk1'), { name: 'sk1', body: 'CURSOR-VERSION' });
    const out = discoverPortableSkills(tmpDir);
    expect(out).toHaveLength(1);
    expect(out[0].skillDir).toContain('.agents/skills/sk1');
  });

  it('falls back to skills/ if no .agents/skills/', () => {
    writeSkill(path.join(tmpDir, 'plug-a', 'skills', 'sk1'), { name: 'sk1' });
    writeSkill(path.join(tmpDir, 'plug-a', '.claude', 'skills', 'sk1'), { name: 'sk1' });
    const out = discoverPortableSkills(tmpDir);
    expect(out[0].skillDir).toContain('plug-a/skills/sk1');
  });

  it('respects user-invocable: false (skipped)', () => {
    writeSkill(path.join(tmpDir, 'plug-a', 'skills', 'public'), { name: 'public' });
    writeSkill(path.join(tmpDir, 'plug-a', 'skills', 'internal'), { name: 'internal', 'user-invocable': 'false' });
    const out = discoverPortableSkills(tmpDir);
    expect(out.map((s) => s.name)).toEqual(['public']);
  });

  it('single-skill plugin: <plugin>/SKILL.md', () => {
    writeSkill(path.join(tmpDir, 'plug-single'), { name: 'plug-single' });
    const out = discoverPortableSkills(tmpDir);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('plug-single');
  });

  it('impeccable-style plugin/skills/<name>/', () => {
    writeSkill(path.join(tmpDir, 'plug-imp', 'plugin', 'skills', 'imp'), { name: 'imp' });
    const out = discoverPortableSkills(tmpDir);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('imp');
  });

  it('gitnexus-style <plugin>-claude-plugin/skills/<name>/ as last-resort fallback', () => {
    writeSkill(
      path.join(tmpDir, 'plug-gn', 'plug-gn-claude-plugin', 'skills', 'gn-sub'),
      { name: 'gn-sub' },
    );
    const out = discoverPortableSkills(tmpDir);
    expect(out.map((s) => s.name)).toEqual(['gn-sub']);
  });

  it('preference order winner blocks lower-priority matches by name', () => {
    writeSkill(path.join(tmpDir, 'plug-a', '.agents', 'skills', 'imp'), { name: 'imp', body: 'WIN' });
    writeSkill(path.join(tmpDir, 'plug-a', 'skills', 'imp'), { name: 'imp', body: 'LOSE' });
    const out = discoverPortableSkills(tmpDir);
    expect(out).toHaveLength(1);
    expect(out[0].skillDir).toContain('.agents/skills/imp');
  });

  it('skips deprecated subtrees', () => {
    writeSkill(path.join(tmpDir, 'plug-a', 'deprecated', 'old-skill'), { name: 'old-skill' });
    writeSkill(path.join(tmpDir, 'plug-a', 'skills', 'live'), { name: 'live' });
    const out = discoverPortableSkills(tmpDir);
    expect(out.map((s) => s.name)).toEqual(['live']);
  });

  it('respects custom denyPlugins option', () => {
    writeSkill(path.join(tmpDir, 'plug-deny', 'skills', 'x'), { name: 'x' });
    writeSkill(path.join(tmpDir, 'plug-keep', 'skills', 'y'), { name: 'y' });
    const out = discoverPortableSkills(tmpDir, { denyPlugins: new Set(['plug-deny']) });
    expect(out.map((s) => s.name)).toEqual(['y']);
  });

  it('bootstrap multi-plugin: workflow skills denied, domain skills included', () => {
    writeSkill(
      path.join(tmpDir, 'bootstrap', 'plugins', 'workflow', 'skills', 'team-build'),
      { name: 'team-build' },
    );
    writeSkill(
      path.join(tmpDir, 'bootstrap', 'plugins', 'domain', 'skills', 'software-engineering'),
      { name: 'software-engineering' },
    );
    writeSkill(
      path.join(tmpDir, 'bootstrap', 'plugins', 'tools', 'skills', 'cortex-code'),
      { name: 'cortex-code' },
    );
    const out = discoverPortableSkills(tmpDir);
    const names = out.map((s) => s.name);
    expect(names).toContain('software-engineering');
    expect(names).toContain('cortex-code');
    expect(names).not.toContain('team-build');
  });

  it('cross-plugin name collision: first plugin alphabetically wins', () => {
    writeSkill(path.join(tmpDir, 'aaa', 'skills', 'dup'), { name: 'dup', body: 'FROM-AAA' });
    writeSkill(path.join(tmpDir, 'bbb', 'skills', 'dup'), { name: 'dup', body: 'FROM-BBB' });
    const out = discoverPortableSkills(tmpDir);
    expect(out).toHaveLength(1);
    expect(out[0].plugin).toBe('aaa');
  });

  it('uses frontmatter name override when present', () => {
    writeSkill(path.join(tmpDir, 'plug', 'skills', 'old-dir-name'), { name: 'real-name' });
    const out = discoverPortableSkills(tmpDir);
    expect(out[0].name).toBe('real-name');
  });
});

describe('syncSkillSymlinks', () => {
  it('creates symlinks for each discovered skill', () => {
    const src = path.join(tmpDir, 'src-a');
    fs.mkdirSync(src, { recursive: true });
    const dst = path.join(tmpDir, 'dst');
    const skills = [
      { name: 'a', skillDir: src, plugin: 'p' },
    ];
    const result = syncSkillSymlinks(dst, skills);
    expect(result.created).toEqual(['a']);
    expect(fs.readlinkSync(path.join(dst, 'a'))).toBe(src);
  });

  it('idempotent on rerun (no churn)', () => {
    const src = path.join(tmpDir, 'src-a');
    fs.mkdirSync(src, { recursive: true });
    const dst = path.join(tmpDir, 'dst');
    syncSkillSymlinks(dst, [{ name: 'a', skillDir: src, plugin: 'p' }]);
    const result = syncSkillSymlinks(dst, [{ name: 'a', skillDir: src, plugin: 'p' }]);
    expect(result.created).toEqual([]);
    expect(result.unchanged).toEqual(['a']);
  });

  it('removes stale links not in current desired set', () => {
    const srcA = path.join(tmpDir, 'src-a');
    const srcB = path.join(tmpDir, 'src-b');
    fs.mkdirSync(srcA, { recursive: true });
    fs.mkdirSync(srcB, { recursive: true });
    const dst = path.join(tmpDir, 'dst');
    syncSkillSymlinks(dst, [
      { name: 'a', skillDir: srcA, plugin: 'p' },
      { name: 'b', skillDir: srcB, plugin: 'p' },
    ]);
    const result = syncSkillSymlinks(dst, [{ name: 'a', skillDir: srcA, plugin: 'p' }]);
    expect(result.removed).toEqual(['b']);
    expect(fs.existsSync(path.join(dst, 'b'))).toBe(false);
  });

  it('preserves non-symlink entries (operator-placed dirs)', () => {
    const dst = path.join(tmpDir, 'dst');
    fs.mkdirSync(dst, { recursive: true });
    fs.mkdirSync(path.join(dst, 'manual'));
    const result = syncSkillSymlinks(dst, []);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(dst, 'manual'))).toBe(true);
  });

  it('updates link when target changes', () => {
    const srcOld = path.join(tmpDir, 'old');
    const srcNew = path.join(tmpDir, 'new');
    fs.mkdirSync(srcOld, { recursive: true });
    fs.mkdirSync(srcNew, { recursive: true });
    const dst = path.join(tmpDir, 'dst');
    syncSkillSymlinks(dst, [{ name: 'a', skillDir: srcOld, plugin: 'p' }]);
    const result = syncSkillSymlinks(dst, [{ name: 'a', skillDir: srcNew, plugin: 'p' }]);
    expect(result.created).toEqual(['a']);
    expect(fs.readlinkSync(path.join(dst, 'a'))).toBe(srcNew);
  });
});
