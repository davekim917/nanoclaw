/**
 * Plugin-skill discovery for Codex parity.
 *
 * Walks a `~/plugins/`-style root and finds every portable skill (SKILL.md)
 * that should be exposed to Codex. The host script and the container-side
 * setup both consume this — same rules apply to `~/plugins/*` on host and
 * `/workspace/plugins/*` inside the container.
 *
 * Discovery preference order per plugin (highest-priority match wins, one
 * skill-name → one path):
 *
 *   1. `<plugin>/.agents/skills/<name>/SKILL.md`        ← runtime-agnostic canonical
 *   2. `<plugin>/skills/<name>/SKILL.md`                ← top-level skills dir
 *   3. `<plugin>/SKILL.md`                              ← single-skill (name = plugin)
 *   4. `<plugin>/plugin/skills/<name>/SKILL.md`         ← impeccable-style
 *   5. `<plugin>/<plugin>-cursor-integration/skills/<name>/SKILL.md`
 *   6. `<plugin>/<plugin>-claude-plugin/skills/<name>/SKILL.md`
 *
 * Skipped:
 *   - Plugins on `denyPlugins` (Claude-runtime-only by design — bootstrap-workflow,
 *     codex plugin, etc.)
 *   - Skill dirs under runtime-specific path segments: `.claude/`, `.cursor/`,
 *     `.opencode/`, `.gemini/`, `.kiro/`, `.trae/`, `.trae-cn/`, `.qoder/`,
 *     `.rovodev/`, `.github/`, `.pi/` (these are runtime-specific duplicates;
 *     prefer `.agents/skills/` which is the canonical multi-runtime version)
 *   - SKILL.md files with `user-invocable: false` in frontmatter
 *   - Deprecated dirs under `<plugin>/deprecated/`
 *   - Plugins under `<plugin>/plugins/<sub>/skills/` when `<sub>` matches a
 *     plugin-specific denylist (e.g. bootstrap-workflow within davekim917/bootstrap)
 */
import fs from 'fs';
import path from 'path';

export interface DiscoveredSkill {
  /** Skill name (used as `~/.codex/skills/<name>/` link basename) */
  name: string;
  /** Absolute path to the skill directory containing SKILL.md */
  skillDir: string;
  /** Plugin folder it came from */
  plugin: string;
}

/**
 * Plugins to skip entirely. These wrap Claude-only runtime functionality
 * (Skill tool, Agent tool, slash-command machinery).
 */
const DEFAULT_DENY_PLUGINS = new Set<string>([
  // bootstrap: many sub-plugins inside; we walk it with a finer-grained denylist
  //            via DENY_SUB_PLUGIN_SKILL_DIRS, not at the top level.
  // codex: skills here are Codex-plugin internal, already loaded via the codex
  //        Claude plugin and either non-user-invocable or specific to Claude.
  'codex',
]);

/**
 * Within a multi-plugin repo (like davekim917/bootstrap, which contains
 * workflow/domain/tools sub-plugins), this set marks the *sub-plugin* skill
 * roots to ignore. Bootstrap-workflow's `/team-*` skills require Claude's
 * Skill/Agent tool to function. Bootstrap-tools/cortex-code is pure prose
 * but currently invokes `cortex` CLI through Bash — portable.
 *
 * Format: `<plugin>/<sub-plugin-skills-segment>`
 */
const DENY_SUB_PLUGIN_SKILL_DIRS = new Set<string>([
  'bootstrap/plugins/workflow/skills',
]);

/**
 * Path segments that mean "runtime-specific copy of a skill" — we prefer the
 * `.agents/skills/` canonical version (or the plugin-author's chosen top-level)
 * over these.
 */
const RUNTIME_SPECIFIC_DIRS = new Set<string>([
  '.claude',
  '.cursor',
  '.opencode',
  '.gemini',
  '.kiro',
  '.trae',
  '.trae-cn',
  '.qoder',
  '.rovodev',
  '.github',
  '.pi',
]);

function hasSkillMd(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readFrontmatter(skillMd: string): Record<string, string> {
  try {
    const content = fs.readFileSync(skillMd, 'utf-8');
    if (!content.startsWith('---')) return {};
    const end = content.indexOf('\n---', 3);
    if (end < 0) return {};
    const block = content.slice(4, end);
    const result: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i);
      if (m) result[m[1]] = m[2].trim();
    }
    return result;
  } catch {
    return {};
  }
}

function isUserInvocable(skillDir: string): boolean {
  const fm = readFrontmatter(path.join(skillDir, 'SKILL.md'));
  return fm['user-invocable'] !== 'false';
}

function readPluginName(skillDir: string): string | null {
  const fm = readFrontmatter(path.join(skillDir, 'SKILL.md'));
  return fm.name || null;
}

/**
 * For a single plugin folder, enumerate every portable skill following the
 * preference order. Returns each skill exactly once (by name) — later
 * matches with the same name are dropped.
 */
function discoverInPlugin(pluginDir: string, pluginName: string): DiscoveredSkill[] {
  const skills = new Map<string, DiscoveredSkill>();

  const recordCandidate = (skillDir: string) => {
    if (!hasSkillMd(skillDir)) return;
    if (!isUserInvocable(skillDir)) return;
    const fmName = readPluginName(skillDir);
    const name = fmName ?? path.basename(skillDir);
    if (skills.has(name)) return; // first match wins (preference order)
    skills.set(name, { name, skillDir, plugin: pluginName });
  };

  // 1. .agents/skills/<name>/
  const agentsSkillsDir = path.join(pluginDir, '.agents', 'skills');
  if (isDirectory(agentsSkillsDir)) {
    for (const sub of fs.readdirSync(agentsSkillsDir)) {
      recordCandidate(path.join(agentsSkillsDir, sub));
    }
  }

  // 2. skills/<name>/
  const topSkillsDir = path.join(pluginDir, 'skills');
  if (isDirectory(topSkillsDir)) {
    for (const sub of fs.readdirSync(topSkillsDir)) {
      recordCandidate(path.join(topSkillsDir, sub));
    }
  }

  // 3. <plugin>/SKILL.md (single-skill plugin)
  recordCandidate(pluginDir);

  // 4. plugin/skills/<name>/ (impeccable's `plugin/` subdir)
  const pluginSubDir = path.join(pluginDir, 'plugin', 'skills');
  if (isDirectory(pluginSubDir)) {
    for (const sub of fs.readdirSync(pluginSubDir)) {
      recordCandidate(path.join(pluginSubDir, sub));
    }
  }

  // 5. <plugin>-cursor-integration/skills/<name>/
  const cursorDir = path.join(pluginDir, `${pluginName}-cursor-integration`, 'skills');
  if (isDirectory(cursorDir)) {
    for (const sub of fs.readdirSync(cursorDir)) {
      recordCandidate(path.join(cursorDir, sub));
    }
  }

  // 6. <plugin>-claude-plugin/skills/<name>/ (last resort)
  const claudePluginDir = path.join(pluginDir, `${pluginName}-claude-plugin`, 'skills');
  if (isDirectory(claudePluginDir)) {
    for (const sub of fs.readdirSync(claudePluginDir)) {
      recordCandidate(path.join(claudePluginDir, sub));
    }
  }

  // 7. multi-plugin repos: <plugin>/plugins/<sub>/skills/<name>/
  //    Common in davekim917/bootstrap. Respect DENY_SUB_PLUGIN_SKILL_DIRS.
  const multiPluginDir = path.join(pluginDir, 'plugins');
  if (isDirectory(multiPluginDir)) {
    for (const sub of fs.readdirSync(multiPluginDir)) {
      const subKey = `${pluginName}/plugins/${sub}/skills`;
      if (DENY_SUB_PLUGIN_SKILL_DIRS.has(subKey)) continue;
      const subSkillsDir = path.join(multiPluginDir, sub, 'skills');
      if (!isDirectory(subSkillsDir)) continue;
      for (const skillName of fs.readdirSync(subSkillsDir)) {
        recordCandidate(path.join(subSkillsDir, skillName));
      }
    }
  }

  return [...skills.values()];
}

export interface DiscoverOptions {
  /** Plugins to skip entirely (matched against folder name) */
  denyPlugins?: Set<string>;
  /** Skills to skip by name (regardless of source plugin) */
  denySkills?: Set<string>;
  /** Paths or path components that should never be traversed (runtime-specific dirs) */
  denyDirSegments?: Set<string>;
}

/**
 * Walk a plugins root and return every portable skill we'd want Codex to see.
 * Pure function — no filesystem writes. Caller decides what to do with the
 * results (typically: symlink each `skillDir` into `<CODEX_HOME>/skills/<name>/`).
 */
export function discoverPortableSkills(
  pluginsRoot: string,
  options: DiscoverOptions = {},
): DiscoveredSkill[] {
  if (!isDirectory(pluginsRoot)) return [];

  const denyPlugins = options.denyPlugins ?? DEFAULT_DENY_PLUGINS;
  const denySkills = options.denySkills ?? new Set<string>();

  const allSkills = new Map<string, DiscoveredSkill>();
  for (const pluginName of fs.readdirSync(pluginsRoot)) {
    if (denyPlugins.has(pluginName)) continue;
    if (RUNTIME_SPECIFIC_DIRS.has(pluginName)) continue;
    const pluginDir = path.join(pluginsRoot, pluginName);
    if (!isDirectory(pluginDir)) continue;
    // Skip deprecated subtree contents — they live at <plugin>/deprecated/ and
    // shouldn't appear as portable skills.
    for (const skill of discoverInPlugin(pluginDir, pluginName)) {
      if (denySkills.has(skill.name)) continue;
      if (skill.skillDir.includes('/deprecated/')) continue;
      // First-plugin-wins by name (alphabetical iteration); a later plugin
      // with the same skill name won't override.
      if (!allSkills.has(skill.name)) allSkills.set(skill.name, skill);
    }
  }
  return [...allSkills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reconcile a target dir of symlinks against a discovered skill set.
 *
 * - Creates one symlink `<dst>/<name> → <skillDir>` for each entry in `skills`.
 * - Removes any existing symlink under `<dst>` whose name is NOT in `skills`.
 * - Leaves non-symlink entries alone (so operator-placed dirs are preserved).
 *
 * Idempotent. Safe to re-run after every spawn.
 */
export function syncSkillSymlinks(dst: string, skills: DiscoveredSkill[]): {
  created: string[];
  removed: string[];
  unchanged: string[];
} {
  fs.mkdirSync(dst, { recursive: true });

  const desired = new Map(skills.map((s) => [s.name, s.skillDir] as const));

  const created: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  // Drop links no longer wanted.
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(dst);
  } catch {
    /* fresh dir */
  }
  for (const entry of existing) {
    if (desired.has(entry)) continue;
    const linkPath = path.join(dst, entry);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(linkPath);
        removed.push(entry);
      }
    } catch {
      /* missing — fine */
    }
  }

  // Write desired links.
  for (const [name, target] of desired) {
    const linkPath = path.join(dst, name);
    let currentTarget: string | null = null;
    try {
      currentTarget = fs.readlinkSync(linkPath);
    } catch {
      /* missing */
    }
    if (currentTarget === target) {
      unchanged.push(name);
      continue;
    }
    try {
      fs.unlinkSync(linkPath);
    } catch {
      /* missing */
    }
    try {
      fs.symlinkSync(target, linkPath);
      created.push(name);
    } catch {
      /* swallow — caller logs */
    }
  }

  return { created, removed, unchanged };
}
