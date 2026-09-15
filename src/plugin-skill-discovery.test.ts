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
    writeSkill(path.join(tmpDir, 'plug-gn', 'plug-gn-claude-plugin', 'skills', 'gn-sub'), { name: 'gn-sub' });
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

  it('bootstrap multi-plugin (codex runtime): native workflow ports denied, domain/tools included', () => {
    // Codex loads BOTH the Claude workflow/ (unusable — needs Claude's Skill/Agent tool) and the
    // workflow-agents port (via .codex-plugin) through native paths, so neither belongs in the
    // portable mirror; domain/tools have no native loader and must be surfaced. (The claude default
    // runtime, by contrast, surfaces its own workflow/ — see DEFAULT_RUNTIME — so this asserts the
    // codex scenario explicitly, which is the "workflow denied" intent.)
    writeSkill(path.join(tmpDir, 'bootstrap', 'plugins', 'workflow', 'skills', 'team-build'), { name: 'team-build' });
    writeSkill(path.join(tmpDir, 'bootstrap', 'plugins', 'workflow-agents', 'skills', 'team-build'), {
      name: 'team-build',
    });
    writeSkill(path.join(tmpDir, 'bootstrap', 'plugins', 'workflow-agents', 'skills', 'team-qa'), {
      name: 'team-qa',
    });
    writeSkill(path.join(tmpDir, 'bootstrap', 'plugins', 'domain', 'skills', 'software-engineering'), {
      name: 'software-engineering',
    });
    writeSkill(path.join(tmpDir, 'bootstrap', 'plugins', 'tools', 'skills', 'cortex-code'), { name: 'cortex-code' });
    const out = discoverPortableSkills(tmpDir, { runtime: 'codex' });
    const names = out.map((s) => s.name);
    expect(names).toContain('software-engineering');
    expect(names).toContain('cortex-code');
    expect(names).not.toContain('team-build');
    expect(names).not.toContain('team-qa');
  });

  it('opencode provisions user-invocable:false helpers (no plugin loader); claude/codex exclude them', () => {
    // opencode has no native plugin loader — the discovery mirror is its ONLY skill delivery,
    // so referenceable helpers (user-invocable:false, e.g. team-verification-before-completion)
    // must be provisioned for it or the visible skills that reference them break. Claude/Codex
    // load those via their plugin loaders, so their mirrors omit them (stay lean).
    writeSkill(path.join(tmpDir, 'plug', 'skills', 'visible'), { name: 'visible' });
    writeSkill(path.join(tmpDir, 'plug', 'skills', 'hidden-helper'), {
      name: 'hidden-helper',
      'user-invocable': 'false',
    });
    const names = (rt: 'claude' | 'codex' | 'opencode') =>
      discoverPortableSkills(tmpDir, { runtime: rt }).map((s) => s.name);
    expect(names('opencode')).toEqual(expect.arrayContaining(['visible', 'hidden-helper']));
    for (const rt of ['claude', 'codex'] as const) {
      expect(names(rt)).toContain('visible');
      expect(names(rt)).not.toContain('hidden-helper');
    }
  });

  it('codex-native sub-plugin (.codex-plugin) is skipped from the codex mirror, kept for opencode', () => {
    // A sub-plugin that ships .codex-plugin is loaded natively by Codex (with its MCP), so the
    // Codex mirror must NOT duplicate it. OpenCode has no codex-plugin loader, so it still gets it.
    // This is the manifest rule — orthogonal to the .nanoclaw-plugin.json marker.
    const sub = path.join(tmpDir, 'role-specific-plugins', 'plugins', 'data-analytics');
    writeSkill(path.join(sub, 'skills', 'build-report'), { name: 'build-report' });
    fs.mkdirSync(path.join(sub, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(sub, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'data-analytics', version: '0.0.0' }),
    );
    expect(discoverPortableSkills(tmpDir, { runtime: 'codex' }).map((s) => s.name)).not.toContain('build-report');
    expect(discoverPortableSkills(tmpDir, { runtime: 'opencode' }).map((s) => s.name)).toContain('build-report');
  });

  it('.nanoclaw-plugin.json denySiblings routes per runtime (default: all three)', () => {
    // A plugin denied for one sibling is skipped ONLY for that sibling.
    writeSkill(path.join(tmpDir, 'data-anthropic', 'skills', 'write-query'), { name: 'write-query' });
    fs.writeFileSync(
      path.join(tmpDir, 'data-anthropic', '.nanoclaw-plugin.json'),
      JSON.stringify({ denySiblings: ['codex'] }),
    );
    const names = (rt: 'claude' | 'codex' | 'opencode') =>
      discoverPortableSkills(tmpDir, { runtime: rt }).map((s) => s.name);
    expect(names('claude')).toContain('write-query');
    expect(names('opencode')).toContain('write-query');
    expect(names('codex')).not.toContain('write-query');
  });

  it('.nanoclaw-plugin.json absent/malformed → delivered to all siblings', () => {
    writeSkill(path.join(tmpDir, 'plug-nomark', 'skills', 'k'), { name: 'k' });
    writeSkill(path.join(tmpDir, 'plug-badmark', 'skills', 'm'), { name: 'm' });
    fs.writeFileSync(path.join(tmpDir, 'plug-badmark', '.nanoclaw-plugin.json'), 'not valid json {');
    for (const rt of ['claude', 'codex', 'opencode'] as const) {
      const names = discoverPortableSkills(tmpDir, { runtime: rt }).map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(['k', 'm']));
    }
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

  it('finds nothing in a sub-plugin directory that has no skills/ of its own', () => {
    // Rules 7 and 8 both gate on `isDirectory(subSkillsDir)`, so a sub-plugin
    // directory with no `skills/` contributes nothing. Pinned on its own terms:
    // the host mask that used to produce such a directory for an excluded
    // sub-plugin was removed (#826). The host copy of this module is asserted
    // identical below.
    writeSkill(path.join(tmpDir, 'bootstrap', 'plugins', 'wwbd', 'skills', 'wwbd'), { name: 'wwbd' });
    fs.mkdirSync(path.join(tmpDir, 'bootstrap', 'plugins', 'orchestrate'), { recursive: true });
    // Rule 8's `<repo>/<sub>` layout is gated on the sub-dir's Claude manifest,
    // which an empty sub-plugin directory also lacks.
    fs.mkdirSync(path.join(tmpDir, 'bootstrap', 'rootlevel'), { recursive: true });

    expect(discoverPortableSkills(tmpDir, { runtime: 'opencode' }).map((s) => s.name)).toEqual(['wwbd']);
  });
});

describe('syncSkillSymlinks (mirror-dir mode)', () => {
  function makeSourceSkill(dir: string, children: Record<string, 'file' | 'dir'> = { 'SKILL.md': 'file' }): string {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, kind] of Object.entries(children)) {
      const p = path.join(dir, name);
      if (kind === 'file') fs.writeFileSync(p, `content-${name}`);
      else fs.mkdirSync(p, { recursive: true });
    }
    return dir;
  }

  it('materializes <dst>/<name>/ as a REAL DIR (Codex requires real dirs)', () => {
    const src = makeSourceSkill(path.join(tmpDir, 'src-a'));
    const dst = path.join(tmpDir, 'dst');
    const result = syncSkillSymlinks(dst, [{ name: 'a', skillDir: src, plugin: 'p' }]);
    expect(result.created).toEqual(['a']);
    const stat = fs.lstatSync(path.join(dst, 'a'));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
  });

  it('children of the skill dir are symlinks back to source (auto-update)', () => {
    const src = makeSourceSkill(path.join(tmpDir, 'src-imp'), {
      'SKILL.md': 'file',
      scripts: 'dir',
      reference: 'dir',
    });
    const dst = path.join(tmpDir, 'dst');
    syncSkillSymlinks(dst, [{ name: 'imp', skillDir: src, plugin: 'p' }]);
    const mirror = path.join(dst, 'imp');
    expect(fs.lstatSync(path.join(mirror, 'SKILL.md')).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(mirror, 'SKILL.md')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf-8')).toBe('content-SKILL.md');
    expect(fs.lstatSync(path.join(mirror, 'scripts')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(mirror, 'scripts'))).toBe(path.join(src, 'scripts'));
  });

  it('idempotent: re-run with same input reports unchanged', () => {
    const src = makeSourceSkill(path.join(tmpDir, 'src-a'));
    const dst = path.join(tmpDir, 'dst');
    syncSkillSymlinks(dst, [{ name: 'a', skillDir: src, plugin: 'p' }]);
    const result = syncSkillSymlinks(dst, [{ name: 'a', skillDir: src, plugin: 'p' }]);
    expect(result.created).toEqual([]);
    expect(result.unchanged).toEqual(['a']);
  });

  it('removes managed mirror dirs when name leaves desired set', () => {
    const srcA = makeSourceSkill(path.join(tmpDir, 'src-a'));
    const srcB = makeSourceSkill(path.join(tmpDir, 'src-b'));
    const dst = path.join(tmpDir, 'dst');
    syncSkillSymlinks(dst, [
      { name: 'a', skillDir: srcA, plugin: 'p' },
      { name: 'b', skillDir: srcB, plugin: 'p' },
    ]);
    const result = syncSkillSymlinks(dst, [{ name: 'a', skillDir: srcA, plugin: 'p' }]);
    expect(result.removed).toEqual(['b']);
    expect(fs.existsSync(path.join(dst, 'b'))).toBe(false);
  });

  it('defers to native install (real files in mirror) — gitnexus setup case', () => {
    const src = makeSourceSkill(path.join(tmpDir, 'src'));
    const dst = path.join(tmpDir, 'dst');
    fs.mkdirSync(dst, { recursive: true });
    fs.mkdirSync(path.join(dst, 'collide'), { recursive: true });
    fs.writeFileSync(path.join(dst, 'collide', 'SKILL.md'), 'NATIVE_INSTALL');
    const result = syncSkillSymlinks(dst, [{ name: 'collide', skillDir: src, plugin: 'p' }]);
    expect(result.skipped).toEqual(['collide']);
    expect(fs.readFileSync(path.join(dst, 'collide', 'SKILL.md'), 'utf-8')).toBe('NATIVE_INSTALL');
  });

  it('preserves operator-placed dirs at the top level', () => {
    const dst = path.join(tmpDir, 'dst');
    fs.mkdirSync(path.join(dst, 'manual'), { recursive: true });
    fs.writeFileSync(path.join(dst, 'manual', 'real-file.txt'), '');
    const result = syncSkillSymlinks(dst, []);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(dst, 'manual', 'real-file.txt'))).toBe(true);
  });

  it('updates child symlinks when source adds a file between runs', () => {
    const src = makeSourceSkill(path.join(tmpDir, 'src'), { 'SKILL.md': 'file' });
    const dst = path.join(tmpDir, 'dst');
    syncSkillSymlinks(dst, [{ name: 'a', skillDir: src, plugin: 'p' }]);
    fs.writeFileSync(path.join(src, 'NEW.md'), '');
    syncSkillSymlinks(dst, [{ name: 'a', skillDir: src, plugin: 'p' }]);
    expect(fs.lstatSync(path.join(dst, 'a', 'NEW.md')).isSymbolicLink()).toBe(true);
  });

  it('removes stale child symlinks when source removes a file', () => {
    const src = makeSourceSkill(path.join(tmpDir, 'src'), { 'SKILL.md': 'file', 'OLD.md': 'file' });
    const dst = path.join(tmpDir, 'dst');
    syncSkillSymlinks(dst, [{ name: 'a', skillDir: src, plugin: 'p' }]);
    fs.unlinkSync(path.join(src, 'OLD.md'));
    syncSkillSymlinks(dst, [{ name: 'a', skillDir: src, plugin: 'p' }]);
    expect(fs.existsSync(path.join(dst, 'a', 'OLD.md'))).toBe(false);
  });

  it('migrates legacy top-level symlinks into mirror dirs', () => {
    const src = makeSourceSkill(path.join(tmpDir, 'src'));
    const dst = path.join(tmpDir, 'dst');
    fs.mkdirSync(dst, { recursive: true });
    fs.symlinkSync(src, path.join(dst, 'legacy'));
    syncSkillSymlinks(dst, [{ name: 'legacy', skillDir: src, plugin: 'p' }]);
    expect(fs.lstatSync(path.join(dst, 'legacy')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(dst, 'legacy')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(dst, 'legacy', 'SKILL.md')).isFile()).toBe(true);
  });
});

describe('host/container copy parity', () => {
  // The container runs its OWN copy of this module against /workspace/plugins
  // (codex-companion-setup.ts). The two files are hand-maintained duplicates,
  // so a discovery rule added to one and not the other silently changes what
  // Codex/OpenCode agents see inside containers while host output looks fine.
  // Comments are allowed to diverge; logic is not.
  it('keeps container/agent-runner/src/plugin-skill-discovery.ts logically identical', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const strip = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
    const [host, container] = await Promise.all([
      fs.promises.readFile(path.join(root, 'src', 'plugin-skill-discovery.ts'), 'utf8'),
      fs.promises.readFile(path.join(root, 'container', 'agent-runner', 'src', 'plugin-skill-discovery.ts'), 'utf8'),
    ]);
    expect(strip(container)).toBe(strip(host));
  });
});
